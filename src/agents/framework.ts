import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { UNTRUSTED_DATA_RULES, clipTrustedText } from './injection.js';
import type { AgentRole, RoleModels } from './types.js';
import type { OllamaChatMessage, OllamaTransport, OllamaUsage } from './ollamaClient.js';
import type { AgentRunRepository } from '../db/repositories/agentRuns.js';
import type { AuditEventRepository } from '../db/repositories/auditEvents.js';
import type { Logger } from '../logger.js';

export class AgentOutputError extends AppError {
  readonly issues: string[];
  readonly attempts: number;
  constructor(message: string, issues: string[], attempts: number) {
    super('AGENT_OUTPUT_INVALID', message);
    this.issues = issues;
    this.attempts = attempts;
  }
}

/** Extracts a JSON document from a model reply (fences/prose tolerated). */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const inside = tryParse(fence[1].trim());
    if (inside.ok) return inside.value;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = tryParse(trimmed.slice(start, end + 1));
    if (sliced.ok) return sliced.value;
  }
  throw new AgentOutputError('model reply does not contain a JSON document', ['no parseable JSON found in reply'], 1);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export interface RunStructuredArgs<T> {
  role: AgentRole;
  purpose: string;
  jobId?: string;
  /** Trusted, operator-authored instruction text. */
  instruction: string;
  /** Trusted task description; untrusted data must be pre-wrapped via wrapUntrusted(). */
  task: string;
  schema: z.ZodType<T>;
  temperature?: number;
}

export interface AgentFrameworkOptions {
  transport: OllamaTransport;
  models: RoleModels;
  maxRepairRetries: number;
  runs: AgentRunRepository;
  audit: AuditEventRepository;
  log: Logger;
}

/**
 * Structured agent runner:
 *  - system prompt always embeds the injection-defense rules (structural, not model-optional)
 *  - role -> model mapping comes only from configuration, never from content
 *  - every reply is JSON-extracted and zod-validated before use
 *  - invalid output triggers a bounded repair loop (maxRepairRetries), then fails safely
 *  - every attempt is recorded in agent_runs and audited
 */
export class AgentFramework {
  constructor(private readonly opts: AgentFrameworkOptions) {}

  systemPrompt(role: AgentRole): string {
    return [
      `You are the ${role.toUpperCase()} agent of WebSalesAi, an AI-assisted website sales and delivery platform.`,
      UNTRUSTED_DATA_RULES,
      clipTrustedText('Answer with exactly one JSON document matching the provided schema.', 500),
    ].join('\n\n');
  }

  async runStructured<T>(args: RunStructuredArgs<T>): Promise<{ output: T; usage: OllamaUsage; model: string; attempts: number }> {
    const model = this.opts.models[args.role];
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: this.systemPrompt(args.role) },
      { role: 'user', content: `${clipTrustedText(args.instruction, 8000)}\n\nTASK:\n${clipTrustedText(args.task, 30000)}\n\nRespond with ONLY the JSON document.` },
    ];

    let lastIssues: string[] = [];
    let attempts = 0;
    const totalAttempts = this.opts.maxRepairRetries + 1;

    while (attempts < totalAttempts) {
      attempts++;
      const run = this.opts.runs.start({
        role: args.role,
        model,
        purpose: args.purpose,
        jobId: args.jobId,
        inputJson: JSON.stringify({ instructionLength: args.instruction.length, taskLength: args.task.length, attempt: attempts }),
      });
      this.opts.audit.append({
        actor: `agent:${args.role}`,
        actorType: 'agent',
        action: 'agent.run_started',
        jobId: args.jobId,
        details: { runId: run.id, purpose: args.purpose, attempt: attempts },
      });

      try {
        const result = await this.opts.transport({
          model,
          messages: attempts === 1 ? messages : [...messages, repairMessage(lastIssues)],
          format: z.toJSONSchema(args.schema, { target: 'draft-7' }) as Record<string, unknown>,
          temperature: args.temperature,
        });

        let parsed: unknown;
        try {
          parsed = extractJson(result.content);
        } catch (err) {
          lastIssues = [err instanceof Error ? err.message : 'unparseable JSON'];
          this.opts.runs.finish(run.id, { status: 'rejected', error: lastIssues.join('; '), usageJson: JSON.stringify(result.usage) });
          this.opts.audit.append({
            actor: `agent:${args.role}`,
            actorType: 'agent',
            action: 'agent.run_finished',
            jobId: args.jobId,
            details: { runId: run.id, status: 'rejected', attempt: attempts, error: lastIssues.join('; ') },
          });
          continue;
        }

        const validated = args.schema.safeParse(parsed);
        if (validated.success) {
          this.opts.runs.finish(run.id, {
            status: 'succeeded',
            outputJson: JSON.stringify(validated.data),
            usageJson: JSON.stringify(result.usage),
          });
          this.opts.audit.append({
            actor: `agent:${args.role}`,
            actorType: 'agent',
            action: 'agent.run_finished',
            jobId: args.jobId,
            details: { runId: run.id, status: 'succeeded', attempt: attempts, model: result.model },
          });
          return { output: validated.data, usage: result.usage, model: result.model, attempts };
        }

        lastIssues = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        this.opts.runs.finish(run.id, { status: 'rejected', error: lastIssues.join('; '), usageJson: JSON.stringify(result.usage) });
        this.opts.audit.append({
          actor: `agent:${args.role}`,
          actorType: 'agent',
          action: 'agent.run_finished',
          jobId: args.jobId,
          details: { runId: run.id, status: 'rejected', attempt: attempts, issues: lastIssues },
        });
      } catch (err) {
        // Transport-level failure: not repairable by the model, fail the run row.
        this.opts.runs.finish(run.id, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
        this.opts.audit.append({
          actor: `agent:${args.role}`,
          actorType: 'agent',
          action: 'agent.run_finished',
          jobId: args.jobId,
          details: { runId: run.id, status: 'failed', attempt: attempts },
        });
        throw err;
      }
    }

    throw new AgentOutputError(
      `agent output invalid after ${attempts} attempt(s)`,
      lastIssues,
      attempts,
    );
  }
}

function repairMessage(issues: string[]): OllamaChatMessage {
  return {
    role: 'user',
    content: `Your previous reply was INVALID for this task. Validation issues:\n${issues
      .map((i) => `- ${clipTrustedText(i, 300)}`)
      .join('\n')}\nReply again with ONLY a corrected JSON document that satisfies the schema. Do not include commentary.`,
  };
}
