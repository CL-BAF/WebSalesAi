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
| CRM, conversations, outreach | Planned |
| Website generation workspace + Builder | Implemented |
| Reviewer QA loop | Planned |
| Preview / production deployment | Planned |
| Payment integration + webhooks | Planned |
| Web dashboard | Planned |

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
| `EMAIL_PROVIDER` | `mock` | no |
| `PAYMENT_PROVIDER` | `mock` | no |
| `DEPLOYMENT_PROVIDER` | `local` | no |
| `OUTREACH_ENABLED` | `false` | no |
| `OUTREACH_REQUIRE_APPROVAL` | `true` | no |
| `OUTREACH_COOLDOWN_HOURS` | `72` (per-contact) | no |
| `OUTREACH_MIN_SCORE` | `60` (min researcher score for auto-qualification) | no |
| `OUTREACH_KILL_SWITCH` | `false` | no |
| `PAYMENT_WEBHOOK_SECRET` | — | **yes** |
| `INBOUND_EMAIL_WEBHOOK_SECRET` | — | **yes** |
| `PRICING_TIERS_JSON` | starter/business/premium (cents) | no |

Configuration is fail-closed: missing required values, invalid enums, or
malformed pricing JSON abort startup with a clear issue list. Secrets are
redacted in logs (pino redact paths + deep-redaction of audit payloads).

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
npm test           # node:test suite (54+ tests) — uses fakes, no network
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

## Provider architecture

All external providers sit behind interfaces so implementations can be
swapped without touching business logic:

| Interface | MVP implementation | Planned |
| --- | --- | --- |
| Email (`EmailProvider`) | in-memory/mock | SMTP / API providers |
| Payment (`PaymentProvider`) | mock with HMAC-signed webhooks | Stripe-style |
| Deployment (`DeploymentProvider`) | local filesystem | hosted targets |
| Ollama transport | HTTP to Ollama Cloud/local | any OpenAI-compatible |

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
