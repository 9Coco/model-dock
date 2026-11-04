import type { Model, Provider, ToolId, WireApi } from './types';
import { isJetBrainsTool } from './jetbrains';

export function isTraeRelayProvider(provider: Provider | undefined): boolean {
  return provider?.kind === 'openai-compatible' && provider.presetId === 'trae-cn-relay';
}

// The relay speaks all three protocols at the configured origin for the same upstream ID.
// Project only the client-facing copy. The saved model still controls supplier tests and edits.
export function traeRelayWireModel(model: Model, provider: Provider | undefined, wireApi: WireApi): Model {
  if (!isTraeRelayProvider(provider) || model.wireApi === wireApi) return model;
  return { ...model, wireApi, ...(model.reasoningEffortFormat === model.wireApi ? { reasoningEffortFormat: wireApi } : {}) };
}

export function traeRelayClientModel(tool: ToolId, model: Model, provider: Provider | undefined): Model {
  if (!isTraeRelayProvider(provider)) return model;
  const wireApi = tool === 'codex' ? 'responses' : tool === 'claude-code' ? 'messages'
    : isJetBrainsTool(tool) || model.wireApi === 'messages' ? 'chat-completions' : model.wireApi;
  return traeRelayWireModel(model, provider, wireApi);
}
