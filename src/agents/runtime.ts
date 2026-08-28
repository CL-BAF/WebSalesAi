import { AgentFramework } from './framework.js';
import { FetchOllamaTransport } from './ollamaClient.js';
import type { AppContext } from '../index.js';

/**
 * Composition root for the agent runtime: builds the real Ollama transport
 * from configuration. Tests construct AgentFramework directly with fakes.
 */
export function createAgentFramework(ctx: AppContext): AgentFramework {
  const fetchTransport = new FetchOllamaTransport({
    baseUrl: ctx.config.ollama.baseUrl,
    apiKey: ctx.config.ollama.apiKey,
    timeoutMs: ctx.config.ollama.timeoutMs,
    retries: ctx.config.ollama.transportRetries,
    log: ctx.log,
  });
  return new AgentFramework({
    transport: (req) => fetchTransport.chat(req),
    models: ctx.config.ollama.models,
    maxRepairRetries: ctx.config.ollama.maxRepairRetries,
    runs: ctx.runs,
    audit: ctx.audit,
    log: ctx.log,
  });
}
