/**
 * Conservative defaults for model discovery when an upstream omits its metadata.
 * These describe the documented model, not an account's entitlement or a gateway's
 * limits. Upstream metadata and explicit user settings must take precedence.
 *
 * Add IDs only after checking both context capacity and image input in an official
 * source. Aliases/snapshots are explicit: never infer capabilities from a family
 * name, an arbitrary date, or a suffix such as latest, thinking, or preview.
 */
export interface ModelMetadata {
  contextWindow: number;
  vision: boolean;
  verifiedAt: string;
  sourceUrl: string;
}

const verifiedAt = '2026-10-08';
const metadataById = new Map<string, Readonly<ModelMetadata>>();

function add(ids: readonly string[], contextWindow: number, vision: boolean, sourceUrl: string, namespaces: readonly string[] = []) {
  const metadata = Object.freeze({ contextWindow, vision, verifiedAt, sourceUrl });
  for (const id of ids) {
    metadataById.set(id, metadata);
    for (const namespace of namespaces) metadataById.set(`${namespace}/${id}`, metadata);
  }
}

function openai(id: string, contextWindow: number, vision: boolean, snapshots: readonly string[] = [], aliases: readonly string[] = []) {
  add([id, ...snapshots, ...aliases], contextWindow, vision, `https://developers.openai.com/api/docs/models/${id}`, ['openai']);
}

openai('gpt-6.1-sol', 1_050_000, true);
openai('gpt-6-astra', 1_050_000, true);
openai('gpt-6-sol', 1_050_000, true);
openai('gpt-6-luna', 1_050_000, true);
openai('gpt-5.6-sol', 1_050_000, true, [], ['gpt-5.6']);
openai('gpt-5.6-terra', 1_050_000, true);
openai('gpt-5.6-luna', 1_050_000, true);
openai('gpt-5.5', 1_050_000, true, ['gpt-5.5-2026-04-23']);
openai('gpt-5.4', 1_050_000, true, ['gpt-5.4-2026-03-05']);
openai('gpt-5.4-pro', 1_050_000, true, ['gpt-5.4-pro-2026-03-05']);
openai('gpt-5.4-mini', 400_000, true, ['gpt-5.4-mini-2026-03-17']);
openai('gpt-5.4-nano', 400_000, true, ['gpt-5.4-nano-2026-03-17']);
openai('gpt-5.3-codex', 400_000, true);
openai('gpt-5.2', 400_000, true, ['gpt-5.2-2025-12-11']);
openai('gpt-5.2-codex', 400_000, true);
openai('gpt-5.1', 400_000, true, ['gpt-5.1-2025-11-13']);
openai('gpt-5', 400_000, true, ['gpt-5-2025-08-07']);
openai('gpt-5-pro', 400_000, true, ['gpt-5-pro-2025-10-06']);
openai('gpt-5-mini', 400_000, true, ['gpt-5-mini-2025-08-07']);
openai('gpt-5-nano', 400_000, true, ['gpt-5-nano-2025-08-07']);
openai('gpt-4.1', 1_047_576, true, ['gpt-4.1-2025-04-14']);
openai('gpt-4.1-mini', 1_047_576, true, ['gpt-4.1-mini-2025-04-14']);
openai('gpt-4.1-nano', 1_047_576, true, ['gpt-4.1-nano-2025-04-14']);
openai('gpt-4o', 128_000, true, ['gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20']);
openai('gpt-4o-mini', 128_000, true, ['gpt-4o-mini-2024-07-18']);
openai('o3', 200_000, true, ['o3-2025-04-16']);
openai('o3-pro', 200_000, true, ['o3-pro-2025-06-10']);
openai('o3-mini', 200_000, false, ['o3-mini-2025-01-31']);
openai('o4-mini', 200_000, true, ['o4-mini-2025-04-16']);
openai('o1', 200_000, true, ['o1-2024-12-17']);
openai('o1-mini', 128_000, false, ['o1-mini-2024-09-12']);

add(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], 1_000_000, true,
  'https://platform.claude.com/docs/en/models/overview', ['anthropic']);
for (const id of ['sonnet-4-6', 'opus-4-6', 'opus-4-7', 'opus-4-8', 'sonnet-5', 'opus-5', 'fable-5']) {
  add([`claude-${id}`], 1_000_000, true, `https://platform.claude.com/docs/en/models/${id}/overview`, ['anthropic']);
}
add(['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'], 200_000, true,
  'https://platform.claude.com/docs/en/models/sonnet-4-5/overview', ['anthropic']);
add(['claude-opus-4-5', 'claude-opus-4-5-20251101'], 200_000, true,
  'https://platform.claude.com/docs/en/models/opus-4-5/overview', ['anthropic']);
add(['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], 200_000, true,
  'https://platform.claude.com/docs/en/models/haiku-4-5/overview', ['anthropic']);

for (const id of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']) {
  // Google publishes an input-token limit instead of a combined context capacity.
  add([id], 1_048_576, true, `https://ai.google.dev/gemini-api/docs/models/${id}`, ['google', 'models']);
}

// Current Flash and Pro have different input modalities; do not infer from DeepSeek.
add(['deepseek-flash'], 1_048_576, true, 'https://api-docs.deepseek.com/api/list-models/', ['deepseek']);
add(['deepseek-v4-pro'], 1_048_576, false, 'https://api-docs.deepseek.com/api/list-models/', ['deepseek']);

// Aliyun specifies decimal 1M and 256k tokens. Only individually listed models.
add(['qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash', 'qwen3.8-omni-flash',
  'qwen3.7-max-2026-06-08', 'qwen3.7-plus', 'qwen3.7-plus-2026-05-26', 'qwen3.7-flash', 'qwen3.7-flash-2026-07-15',
  'qwen3.6-plus', 'qwen3.6-plus-2026-04-02', 'qwen3.6-flash', 'qwen3.6-flash-2026-04-16',
  'qwen3.5-plus', 'qwen3.5-plus-2026-02-15', 'qwen3.5-flash', 'qwen3.5-flash-2026-02-23'],
1_000_000, true, 'https://help.aliyun.com/zh/model-studio/vision-model/', ['qwen']);
add(['qwen3.6-35b-a3b', 'qwen3.5-omni-plus'], 256_000, true, 'https://help.aliyun.com/zh/model-studio/vision-model/', ['qwen']);

add(['glm-5'], 200_000, false, 'https://docs.z.ai/guides/llm/glm-5', ['z-ai']);
add(['glm-5.2'], 1_000_000, false, 'https://docs.z.ai/guides/llm/glm-5.2', ['z-ai']);
add(['glm-5.3'], 1_000_000, false, 'https://docs.z.ai/guides/llm/glm-5.3', ['z-ai']);
add(['glm-5.3-flash', 'glm-5.3-flashx'], 1_000_000, true, 'https://docs.z.ai/guides/vlm/glm-5.3-flash', ['z-ai']);
add(['glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx'], 200_000, false, 'https://docs.z.ai/guides/llm/glm-4.7', ['z-ai']);
add(['glm-4.6v', 'glm-4.6v-flash', 'glm-4.6v-flashx'], 128_000, true, 'https://docs.z.ai/guides/vlm/glm-4.6v', ['z-ai']);

// These guides publish rounded 1M/256K capacities. Keep conservative decimal
// defaults; an upstream's precise token limit always wins over this dictionary.
add(['kimi-k3'], 1_000_000, true, 'https://platform.kimi.ai/docs/guide/kimi-k3-quickstart', ['moonshotai']);
add(['kimi-k2.6'], 256_000, true, 'https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart', ['moonshotai']);
add(['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'], 256_000, true,
  'https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart', ['moonshotai']);
add(['grok-4.7'], 500_000, true, 'https://docs.x.ai/developers/models/grok-4.7', ['x-ai']);

/** Look up an exact documented ID; return a copy so callers cannot edit defaults. */
export function lookupModelMetadata(upstreamId: string): ModelMetadata | undefined {
  const metadata = metadataById.get(upstreamId.trim().toLowerCase());
  return metadata ? { ...metadata } : undefined;
}
