import type { Model, Provider, ToolId, WireApi } from './types';
import { isJetBrainsTool } from './jetbrains';

export function isTraeRelayProvider(provider: Provider | undefined): boolean {
  return provider?.kind === 'openai-compatible' && provider.presetId === 'trae-cn-relay';
}

// Built-in account adapters dispatch the requested protocol in the existing gateway.
// They reject unsupported semantics explicitly; projecting metadata does not prove inference.
// Project only the client-facing copy. Saved models still control supplier tests and edits.
export function traeRelayWireModel(model: Model, provider: Provider | undefined, wireApi: WireApi): Model {
  // Central's first-party OpenAI proxy has both Chat and Responses endpoints.
  // Its Anthropic proxy uses Messages. Do not project either into the other.
  if (provider?.nativeAdapter === 'jetbrains-central' && (!model.upstreamId.startsWith('openai/') || wireApi === 'messages')) return model;
  if ((!isTraeRelayProvider(provider) && !provider?.nativeAdapter) || model.wireApi === wireApi) return model;
  return { ...model, wireApi, ...(model.reasoningEffortFormat === model.wireApi ? { reasoningEffortFormat: wireApi } : {}) };
}

export function traeRelayClientModel(tool: ToolId, model: Model, provider: Provider | undefined): Model {
  if (provider?.nativeAdapter === 'jetbrains-central') return tool === 'codex' && model.upstreamId.startsWith('openai/') ? traeRelayWireModel(model, provider, 'responses') : model;
  if (!isTraeRelayProvider(provider) && !provider?.nativeAdapter) return model;
  const wireApi = tool === 'codex' ? 'responses' : tool === 'claude-code' ? 'messages'
    : isJetBrainsTool(tool) || model.wireApi === 'messages' ? 'chat-completions' : model.wireApi;
  return traeRelayWireModel(model, provider, wireApi);
}
