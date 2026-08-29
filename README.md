# WebSalesAi

AI-assisted website sales and delivery platform. WebSalesAi researches public
business leads, manages compliant outreach, gathers website requirements,
generates customer websites in isolated workspaces, reviews them through an
independent QA loop, deploys private previews, and collects payment through
deterministic payment integration — while **never giving an LLM authority over
money, credentials, shell access, or production deployments**.

AI inference runs on **Ollama Cloud** models (default: `glm-5.3-flash`) through
ordinary HTTP API calls managed by this application. All external side effects
(email, payments, deployments) are deterministic application code behind
provider interfaces.

## Status

This project is under active development. The table below tracks which
capabilities are implemented and verified by tests:

| Capability | Status |
| --- | --- |
| Configuration (fail-closed validation, secret redaction) | Implemented |
| SQLite persistence with checksummed migrations | Implemented |
| Workflow state machine (validated transitions, CAS concurrency, audit) | Implemented |
| Idempotency layer for external actions | Implemented |
| Ollama runtime (per-role models, structured outputs, bounded retries) | Implemented |
| Prompt-injection containment for untrusted content | Implemented |
| SSRF-guarded website fetching (redirect hops validated, size/time bounded) | Implemented |
| Lead import (dedupe by website host, suppression list) + Researcher agent | Implemented |
| Actor-gated transitions (money/deploy/human-review edges restricted by actor type) | Implemented |
| CRM threading, reply classification, requirements capture | Implemented |
| Outreach guards (approval, kill switch, limits, cooldown, suppression at send time) | Implemented |
| Website generation workspace + Builder | Implemented |
| Reviewer QA loop (bounded cycles, deterministic overrule) | Implemented |
| Preview/production deployment (local provider, guarded) | Implemented |
| Payment integration (configured pricing, HMAC-signed mock webhook, event dedup) | Implemented |
| Web dashboard (session auth, CSRF, rate limiting, JSON API, webhook routes) | Implemented |

## Architecture

```
                     ┌────────────────────────────────────────────┐
                     │                Express API                 │
                     │   dashboard UI · JSON API · webhooks       │
                     └───────────────┬────────────────────────────┘
                                     │
             ┌───────────────────────┴────────────────────────┐
             │           Workflow Engine (deterministic)      │
             │  state machine · transition guard · audit      │
             └──┬──────────┬──────────┬──────────┬────────────┘
                │          │          │          │
        ┌───────┴──┐  ┌────┴────┐ ┌───┴────┐ ┌───┴───────┐
        │ Research │  │  Sales  │ │Builder │ │ Reviewer  │   ← AI roles
        └───────┬──┘  └────┬────┘ └───┬────┘ └───┬───────┘
                │          │          │          │
             ┌──┴──────────┴──────────┴──────────┴──┐
             │  Agent Framework (Ollama runtime)    │
             │  schema-validated structured outputs │
             └──────────────────┬───────────────────┘
                                │
                        ┌───────┴────────┐
                        │  Ollama Cloud  │  glm-5.3-flash (configurable)
                        └────────────────┘

  Providers (interfaces, swappable): Email · Payment · Preview/Prod Deploy
  Persistence: SQLite (node:sqlite) — leads, jobs, conversations, payments,
               deployments, agent runs, reviews, audit events, suppressions
```

### Workflow state machine

Job state is deterministic application code — never an LLM decision. Every
transition is validated against an explicit allowed-transition table, applied
with an optimistic (`WHERE state = ?`) guarded update inside a transaction, and
recorded as a durable audit event.

States: `LEAD_DISCOVERED → RESEARCHING → READY_FOR_OUTREACH →
AWAITING_OUTREACH_APPROVAL → OUTREACH_SENT → AWAITING_REPLY →
CONVERSATION_ACTIVE → INTERESTED → REQUIREMENTS_PENDING → READY_TO_BUILD →
BUILDING → REVIEWING → PREVIEW_READY → PREVIEW_SENT →
AWAITING_CLIENT_APPROVAL → CLIENT_APPROVED → AWAITING_PAYMENT →
PAYMENT_CONFIRMED → READY_FOR_PRODUCTION → DEPLOYING → COMPLETED`

Terminal states: `COMPLETED`, `LEAD_REJECTED`, `OPTED_OUT`.
Guard states reachable from any non-terminal state: `OPTED_OUT`,
`NEEDS_HUMAN_REVIEW`, `FAILED` (FAILED is retryable; NEEDS_HUMAN_REVIEW
resumes to explicit states).

**Privileged transitions are actor-gated** (`src/domain/workflow.ts`): the
engine enforces per-edge actor allowlists on top of the transition table.
Examples: `PAYMENT_CONFIRMED` may only be performed by the `provider` (verified
webhook) or `owner`; leaving `NEEDS_HUMAN_REVIEW` is `owner`-only; sending from
the outreach approval state and all production-deployment edges are
`system`/`owner`-only. An `agent` actor can never confirm payment, exit human
review, trigger deployment, mark completion, opt out a lead, or unilaterally
fail a job. Every rejection is audited.

Source: `src/domain/workflow.ts`, applied by `src/engine/workflowEngine.ts`.

### Agent framework

- One Ollama chat client (`src/agents/ollamaClient.ts`) with bearer auth,
  request timeouts, and bounded transport retries (429/5xx/timeout only).
- Per-role model configuration (`OLLAMA_MODEL_*` overrides `OLLAMA_MODEL`);
  the role→model mapping comes from configuration only and can never be
  altered by model or web content.
- Structured outputs: prompts request JSON, the JSON schema of the expected
  zod type is passed as Ollama `format`, replies are extracted and
  zod-validated. Invalid output triggers a bounded repair loop
  (`OLLAMA_MAX_REPAIR_RETRIES`, default 2) then fails safely
  (`AgentOutputError`).
- Prompt-injection containment: all untrusted content (web pages, emails) is
  wrapped in randomized, collision-checked `<untrusted>` delimiters, control
  characters and spoofed tags are neutralized, content is truncated to bounds,
  and every system prompt embeds non-overridable security rules
  (`src/agents/injection.ts`).
- Every attempt is persisted to `agent_runs` (role, model, purpose, status,
  usage metadata) and audited.

### Data model

SQLite via the built-in `node:sqlite` driver (no native addons). Checksummed
ordered migrations in `src/db/migrations.ts` run automatically at boot.

> **Note:** migration `001` was amended while the schema was still
> pre-release, so its checksum changed. If you created a database with an
> older build, boot now fails with `MigrationDriftError` — this is expected,
> not a bug: delete your dev database file and reboot (dev data only).
> Never modify an applied migration once real data exists; add a new
> migration instead.

Entities: businesses, leads, workflow_jobs, conversations, messages,
outreach_drafts, outreach_log, suppression_entries, website_projects,
requirements, agent_runs, reviews, deployments, payments, payment_events,
audit_events, idempotency_keys, app_settings.

**Lead deduplication is host-based** (one lead per website host, `002`
migration): importing a second lead with the same domain returns `duplicate`
with an audit trail. Caveat: multi-tenant hosts (marketplace/directory
profile URLs) will falsely dedupe — the skip is audited and visible, and the
suppression/import path remains under owner control.

Repository queries are scoped by entity ids (job/lead/conversation) — no
global table scans for job-scoped data.

### Idempotency

`idempotency_keys` backs `IdempotencyRepository.runOnce(key, scope, fn)`:
external side effects (outbound email, invoice creation, deployments) execute
at most once per key; replays return the stored result. The result is stored
in the same transaction as the side effect's database writes, so crashes
cannot double-apply.

## Installation

Prerequisites: **Node.js 24+** (uses the built-in `node:sqlite` module).

```bash
npm install
cp .env.example .env    # then edit values (secrets required outside NODE_ENV=test)
```

The database schema is created automatically on first boot (`DATABASE_PATH`,
default `./data/websalesai.sqlite`).

Configuration is fail-closed: missing required values, invalid enums, or
malformed pricing JSON abort startup with a clear issue list. Secrets are
redacted in logs (pino redact paths + deep-redaction of audit payloads). The
complete annotated variable table lives in the Configuration reference below
and in `.env.example`.

## Running

```bash
npm run dev        # tsx watch mode (development)
npm run build      # compile to dist/
npm start          # run compiled output
```

In mock mode (the defaults) the platform performs **no** real emails, no real
payments, and no external deployments.

## Testing

```bash
npm test           # node:test suite (184 tests) — uses fakes, no network
npm run typecheck  # strict TypeScript check including tests
npm run build      # production compile
npm audit          # dependency audit
```

Tests cover: workflow transition legality (including illegal paths), CAS
transition races, migration idempotency and checksum drift, FK enforcement,
idempotency semantics, config fail-closed behavior, secret redaction
(pino output + audit rows), agent structured-output repair bounds, transport
retry bounds, injection wrapping, and API-key leak prevention.

## Safety model

- **Human approval required for initial cold outreach** (default
  `OUTREACH_REQUIRE_APPROVAL=true`).
- **Global outbound kill switch** and **pause automation** toggle (env-seeded,
  runtime-toggleable via `app_settings`).
- Outreach limits: per-day cap, per-domain daily cap, per-contact cooldown,
  suppression list (with `+tag` subaddress normalization), opt-out
  enforcement. Guards are re-evaluated **inside** the send transaction so a
  mid-pipeline opt-out cannot slip through; conversation replies skip only the
  cold-contact cooldown/domain caps (a customer who just wrote to us gets an
  answer), never the kill switch, pause, suppression, or global daily cap.
- **Payments are deterministic application code.** The AI may only request
  payment creation after verified customer approval; the amount, currency,
  and merchant come from configuration (`PRICING_TIERS_JSON`). Payment status
  is accepted only from verified provider webhooks (HMAC signature
  verification, event deduplication) — never from AI output.
- **Production deployment** requires reviewer PASS + explicit client approval
  + confirmed payment. Deployment credentials never enter model prompts.
- **No arbitrary shell access for models.** Website builds run through an
  allowlisted command layer (`src/website/exec.ts`): only `git` (fixed
  subcommand set, dangerous args refused) and `node --version` may run, with
  cwd containment, no shell, and bounded time/output. Model output never
  reaches the command layer — only file content, written through
  schema-validated, containment-checked, symlink-proof paths.
- **Transactional outbox for all provider calls** (email today; payments and
  deployments use the same idempotency layer): guards are re-checked inside a
  short sync transaction that claims the work, the network call runs with NO
  transaction open, and completion is a second short transaction. Sync
  transactions refuse to interleave with an open async transaction, so no
  flow's writes can be trapped in another's rollback.
- Secrets only from environment; `.env` is gitignored; logs redact secrets.

## Repository layout

```
src/
  config.ts            fail-closed env configuration (zod)
  logger.ts            pino logger + deep secret redaction
  domain/              workflow states, transitions, errors, ids
  db/                  SQLite wrapper, migrations, repositories
  engine/              deterministic workflow engine
  agents/              Ollama runtime, agent framework, schemas, injection guard
  http/                API, webhooks, dashboard (with later stages)
tests/                 node:test suites (offline, fakes for all providers)
```

## API surface and webhook contract

Dashboard: `GET /` serves the single-page dashboard (login, summary counters,
job list, lead/job detail, action buttons for approve/reject/research/build/
review/deploy/opt-out/kill switch/pause).

Authentication: session cookie (`HttpOnly`, `SameSite=Strict`, signed with
`SESSION_SECRET`, 12h TTL) issued by `POST /login` (rate limited: 10/15min per
IP). All `/api/*` routes require the session. Mutating `/api/*` routes require
a double-submit CSRF header (`x-csrf-token` matching the `wsa_csrf` cookie;
obtain via `GET /api/csrf`). General API rate limit: 600/min per IP.

JSON API (session + CSRF): `GET /api/summary`, `GET /api/jobs`,
`GET /api/jobs/:id` (full lead/job view incl. audit trail), `POST
/api/leads/import`, `POST /api/jobs/:id/{research,draft-outreach,review,build,
deploy-preview,deploy-production,payment-request,transition,opt-out}`,
`POST /api/outreach/drafts/:id/{approve,reject}`, `GET|POST /api/settings`.

Webhooks (no session; signature-verified, rate limited 120/min per IP):

| Route | Signature scheme | Behaviour |
| --- | --- | --- |
| `POST /webhooks/payment` | provider header (mock: `x-mock-signature`), HMAC-SHA256 over raw body, timing-safe compare | raw body required; events deduped by `(provider, event_id)`; unknown references recorded but inert (200); invalid signature 401; no secret configured 503 (fail-closed) |
| `POST /webhooks/email` | `x-inbound-signature`, HMAC-SHA256 over raw body | body `{from, subject?, body, externalId?, provider?}`; threaded into the CRM and processed idempotently; disabled (503) unless `INBOUND_EMAIL_WEBHOOK_SECRET` is set |

Preview sites are served read-only at `/preview/<jobId>/…` and accepted
production deployments at `/production/<jobId>/…`, both with strict path
containment.

## Configuration reference

See `.env.example` for the full annotated list. Highlights:

| Variable | Default | Secret |
| --- | --- | --- |
| `NODE_ENV` | `development` | no |
| `PORT` | `3000` | no |
| `DATABASE_PATH` | `./data/websalesai.sqlite` | no |
| `LOG_LEVEL` | `info` | no |
| `DASHBOARD_PASSWORD` | required (fail-closed) | **yes** |
| `SESSION_SECRET` | required (fail-closed) | **yes** |
| `OLLAMA_BASE_URL` | `https://ollama.com` | no |
| `OLLAMA_API_KEY` | — | **yes** |
| `OLLAMA_MODEL` | `glm-5.3-flash` | no |
| `OLLAMA_MODEL_{RESEARCHER,SALES,BUILDER,REVIEWER}` | `OLLAMA_MODEL` | no |
| `OLLAMA_MAX_REPAIR_RETRIES` | `2` | no |
| `OLLAMA_TRANSPORT_RETRIES` | `2` | no |
| `REVIEW_MAX_CYCLES` | `5` | no |
| `REQUIRE_PAYMENT_FOR_PRODUCTION` | `true` (**fail-closed**; `false` = owner-authorized override that allows production deploy without confirmed payment) | no |
| `EMAIL_PROVIDER` | `mock` (`resend` = production) | no |
| `PAYMENT_PROVIDER` | `mock` (`stripe` = production) | no |
| `DEPLOYMENT_PROVIDER` | `local` (`cloudflare` = hosted) | no |
| `RESEND_API_KEY` | — (`re_…`) | **yes** |
| `RESEND_FROM` | — (verified sender identity, e.g. `WebSalesAi <replies@yourdomain>`) | no |
| `RESEND_SENDER_DOMAIN` | — (default: domain of `RESEND_FROM`) | no |
| `RESEND_WEBHOOK_SECRET` | — (`whsec_…` svix signing secret) | **yes** |
| `STRIPE_SECRET_KEY` | — (`sk_test_…`/`sk_live_…`, prefix-validated) | **yes** |
| `STRIPE_WEBHOOK_SECRET` | — | **yes** |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_PAGES_PROJECT` | — | **yes** (token) |
| `PRODUCTION_EXTERNAL_ACTIONS_ENABLED` | `false` (**master gate**; real providers act only when true) | no |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | no |
| `DATABASE_PATH` | `./data/websalesai.sqlite` | no |
| `LOG_LEVEL` | `info` | no |
| `NODE_ENV` | `development` | no |
| `OLLAMA_TIMEOUT_MS` / `OLLAMA_MAX_REPAIR_RETRIES` / `OLLAMA_TRANSPORT_RETRIES` | `120000` / `2` / `2` | no |
| `EMAIL_PROVIDER` | `mock` | no |
| `PAYMENT_PROVIDER` | `mock` | no |
| `DEPLOYMENT_PROVIDER` | `local` | no |
| `OUTREACH_ENABLED` | `false` | no |
| `OUTREACH_REQUIRE_APPROVAL` | `true` | no |
| `OUTREACH_MAX_PER_DAY` | `20` | no |
| `OUTREACH_MAX_PER_DOMAIN_PER_DAY` | `1` | no |
| `OUTREACH_COOLDOWN_HOURS` | `72` (per-contact) | no |
| `OUTREACH_MIN_SCORE` | `60` (min researcher score for auto-qualification) | no |
| `OUTREACH_KILL_SWITCH` | `false` | no |
| `AUTOMATION_PAUSED` | `false` | no |
| `PAYMENT_WEBHOOK_SECRET` | — | **yes** |
| `INBOUND_EMAIL_WEBHOOK_SECRET` | — | **yes** (legacy route removed; Resend uses `RESEND_WEBHOOK_SECRET`) |
| `WORKSPACES_ROOT` / `PREVIEWS_ROOT` / `PRODUCTION_DEPLOYS_ROOT` | `./workspaces` / `./previews` / `./production-deploys` | no |
| `PRICING_CURRENCY` | `USD` (Stripe supports AUD etc.) | no |
| `PRICING_TIERS_JSON` | starter/business/premium (cents) | no |
| `FETCH_TIMEOUT_MS` / `FETCH_MAX_BYTES` | `20000` / `2000000` | no |
| `EXEC_TIMEOUT_MS` | `120000` | no |

## Production integrations (Resend / Stripe / Cloudflare)

Mock providers remain the default and everything works fully offline. Real
providers activate when **both** their `*_PROVIDER` variable selects them
**and** `PRODUCTION_EXTERNAL_ACTIONS_ENABLED=true`:

- **Email (Resend)**: `EMAIL_PROVIDER=resend` + `RESEND_API_KEY`, `RESEND_FROM`
  (a verified sending identity), `RESEND_WEBHOOK_SECRET` (svix signing secret).
  Point your domain's inbound MX at Resend and register `POST
  <PUBLIC_BASE_URL>/webhooks/resend` as the received-email webhook. Replies
  are verified (svix), retrieved with bounded size, normalized to plain text,
  threaded via References/In-Reply-To, and processed by the standard reply
  pipeline (opt-out/suppression apply).
- **Payments (Stripe)**: `PAYMENT_PROVIDER=stripe` + `STRIPE_SECRET_KEY`
  (prefix-validated `sk_test_`/`sk_live_`) + `STRIPE_WEBHOOK_SECRET`. The app
  creates hosted Checkout Sessions (card data never touches WebSalesAi) and
  confirms payment ONLY from signature-verified `checkout.session.*` events,
  cross-validated against the stored amount/currency/metadata. Subscribe only
  to `checkout.session.completed`, `checkout.session.expired`,
  `checkout.session.async_payment_failed`. Test mode = `sk_test_…` keys.
- **Deployment (Cloudflare Pages)**: `DEPLOYMENT_PROVIDER=cloudflare` +
  `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_PAGES_PROJECT`.
  Deploys run the official wrangler CLI programmatically (no shell; child env
  is allowlisted; token via env only). Preview URLs are **unlisted, not
  access-controlled**; production = the project's production branch.
- **Readiness gate**: `PRODUCTION_EXTERNAL_ACTIONS_ENABLED=false` (default)
  forces mock providers even when real ones are configured (loud startup
  warning + dashboard shows MOCK). Setting it `true` allows the configured
  providers to act — approval gates, suppression, kill switch, payment checks
  and deployment guards remain fully in force.

### First sandbox test

```bash
cp .env.example .env          # mock defaults are safe
npm install && npm test       # includes the S10 sandbox E2E (offline)
npm run build && npm start    # dashboard on PORT (mock providers)
```

The sandbox end-to-end is automated in `tests/phase2E2E.test.ts`: it runs the
documented flow with every external action clearly simulated. Live provider
verification requires real credentials and is intentionally skipped:
set the `RESEND_*` / `STRIPE_*` / `CLOUDFLARE_*` variables and run
`npx tsx scripts/cloudflareSpike.ts` (exits with a loud SKIPPED without
credentials — skipped is never reported as proof).

### Disabling outreach immediately

Set the kill switch in the dashboard (or `POST /api/settings {killSwitch:true}`),
or set `OUTREACH_KILL_SWITCH=true` in `.env` and restart. `OUTREACH_ENABLED=false`
alone already prevents all outbound email.

## Provider architecture

All external providers sit behind interfaces so implementations can be
swapped without touching business logic:

| Interface | Default (mock) | Production implementation |
| --- | --- | --- |
| Email (`EmailProvider`) | in-memory/mock | **Resend** (`EMAIL_PROVIDER=resend`) — outbound API + svix-verified inbound webhooks |
| Payment (`PaymentProvider`) | mock with HMAC-signed webhooks | **Stripe** hosted Checkout (`PAYMENT_PROVIDER=stripe`) |
| Deployment (`DeploymentProvider`) | local filesystem | **Cloudflare Pages** (`DEPLOYMENT_PROVIDER=cloudflare`, via programmatic wrangler) |
| Ollama transport | HTTP to Ollama Cloud/local | any OpenAI-compatible endpoint |

The MVP ships only implementations that are actually exercised by tests;
unimplemented providers fail fast with explicit errors instead of silently
misbehaving.

## Security notes

- Never commit `.env` or any real secret. `.env.example` contains placeholders only.
- The dashboard requires authentication; change `DASHBOARD_PASSWORD` and
  `SESSION_SECRET` from the example values before any real use.
- Treat all fetched web content and inbound email as untrusted input; the
  agent framework applies layered prompt-injection defenses, but automated
  actions stay behind human approval gates by design.
- This software automates business outreach — you are responsible for
  complying with anti-spam and data-protection laws in your jurisdiction
  (consent, identification, opt-out handling).

## License

License placeholder — to be decided before any production use.

## Support

Internal project; contact the repository owner for access or questions.
