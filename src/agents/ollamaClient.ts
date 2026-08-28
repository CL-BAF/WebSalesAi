import { ExternalActionError } from '../domain/errors.js';
import type { Logger } from '../logger.js';

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  /** JSON schema for structured output (passed to Ollama `format`), or 'json'. */
  format?: Record<string, unknown> | 'json';
  temperature?: number;
  numPredict?: number;
}

export interface OllamaUsage {
  promptTokens?: number;
  responseTokens?: number;
  totalTokens?: number;
}

export interface OllamaChatResult {
  model: string;
  content: string;
  usage: OllamaUsage;
}

/** Transport abstraction: real fetch transport in production, fakes in tests. */
export type OllamaTransport = (req: OllamaChatRequest) => Promise<OllamaChatResult>;

class RetryableTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableTransportError';
  }
}

export interface FetchTransportOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  retries: number;
  log?: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Real HTTP transport for the Ollama API (cloud or local).
 * - Bearer auth only when an API key is configured.
 * - Bounded transport retries for retryable failures (timeouts, 429, 5xx).
 * - Error messages never include the API key or response bodies.
 */
export class FetchOllamaTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: FetchTransportOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Scrubs the configured API key from any text destined for errors/logs. */
  private redact(text: string): string {
    if (!this.opts.apiKey) return text;
    return text.split(this.opts.apiKey).join('[REDACTED]');
  }

  async chat(req: OllamaChatRequest): Promise<OllamaChatResult> {
    let lastError: Error = new ExternalActionError('ollama transport did not run');
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      try {
        return await this.once(req);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const retryable = lastError instanceof RetryableTransportError;
        this.opts.log?.debug({ attempt, retryable, error: lastError.message }, 'ollama transport attempt failed');
        if (!retryable || attempt === this.opts.retries) break;
      }
    }
    throw new ExternalActionError(`ollama transport failed: ${lastError.message}`);
  }

  private async once(req: OllamaChatRequest): Promise<OllamaChatResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers['authorization'] = `Bearer ${this.opts.apiKey}`;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: false,
    };
    if (req.format) body['format'] = req.format;
    if (req.temperature !== undefined) body['options'] = { temperature: req.temperature, ...(req.numPredict ? { num_predict: req.numPredict } : {}) };

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new RetryableTransportError(
        isTimeout
          ? `timeout after ${this.opts.timeoutMs}ms`
          : `connection error: ${this.redact(err instanceof Error ? err.message : 'unknown')}`,
      );
    }

    if (res.status === 429 || res.status >= 500) {
      throw new RetryableTransportError(`ollama http ${res.status}`);
    }
    if (!res.ok) {
      throw new ExternalActionError(`ollama request rejected with http ${res.status}`);
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ExternalActionError('ollama returned a non-JSON response');
    }
    const message = (data as { message?: { content?: unknown } })['message'];
    const content = typeof message?.['content'] === 'string' ? message['content'] : '';
    if (!content.trim()) {
      throw new ExternalActionError('ollama returned an empty completion');
    }
    const raw = data as Record<string, unknown>;
    const usage: OllamaUsage = {
      promptTokens: typeof raw['prompt_eval_count'] === 'number' ? raw['prompt_eval_count'] : undefined,
      responseTokens: typeof raw['eval_count'] === 'number' ? raw['eval_count'] : undefined,
      totalTokens:
        typeof raw['prompt_eval_count'] === 'number' && typeof raw['eval_count'] === 'number'
          ? (raw['prompt_eval_count'] as number) + (raw['eval_count'] as number)
          : undefined,
    };
    return { model: typeof raw['model'] === 'string' ? raw['model'] : req.model, content, usage };
  }
}
