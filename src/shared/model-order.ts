import type { DiscoveryResult } from './catalog-types';

type CatalogSource = NonNullable<DiscoveryResult['history']>['source'];
const otherKey = '#other';

// Family names and version information describe the upstream ID, independent of the editable alias.
const seriesLabels: Record<string, string> = {
  gpt: 'GPT', 'openai-o': 'OpenAI o 系列', 'gpt-image': 'GPT Image', 'gpt-audio': 'GPT Audio',
  'gpt-realtime': 'GPT Realtime', 'gpt-oss': 'GPT OSS', 'text-embedding': 'Text Embedding',
  'dall-e': 'DALL·E', claude: 'Claude', deepseek: 'DeepSeek', gemini: 'Gemini', qwen: 'Qwen',
  llama: 'Llama', grok: 'Grok', kimi: 'Kimi', glm: 'GLM', minimax: 'MiniMax', mistral: 'Mistral',
  mimo: 'MiMo', seed: 'Seed', step: 'Step', whisper: 'Whisper', codex: 'Codex', tts: 'TTS',
};
const prefixes = Object.keys(seriesLabels).sort((a, b) => b.length - a.length);
const names = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const compareNames = (a: string, b: string) => names.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

// A literal calendar date may appear as YYYY-MM-DD or YYYYMMDD. Short codes such as
// 0125 have no unambiguous year. Do not treat them as a generation or assign a release date.
const snapshotDate = /(?:^|[-_:@])((?:19|20)\d{2})-?(0[1-9]|1[0-2])-?(0[1-9]|[12]\d|3[01])(?=$|[-_:@])/;
// Dotted and hyphenated versions occur in the same catalog. Require a complete token
// to exclude parameter sizes (32B), context sizes (128K) and quantization tags (Q4).
const versionNumber = /(?:^|[-_:. ])(?:[vrkm])?(\d{1,3}(?:\.\d{1,3}|-\d{1,2})*)(?:[ov])?(?=$|[-_: ])/;

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function describeModel(id: string, source?: CatalogSource) {
  const path = id.trim().toLowerCase().split('/');
  const rawLeaf = path.pop() || '';
  // TRAE used this config ID for the Seed-Code entry in its historical directory.
  const leaf = source === 'trae-client' && id.toLowerCase() === 'doubao_1_6'
    ? 'seed-code'
    : rawLeaf.replace(/^chatgpt(?=[-\d])/, 'gpt').replace(/^doubao-(?=seed(?:-|$))/, '');
  const date = leaf.match(snapshotDate);
  const name = date ? leaf.replace(snapshotDate, '') : leaf;
  const prefix = prefixes.find(p => name.startsWith(p) && /^(?:$|[-_:. \d])/.test(name.slice(p.length)));
  const oSeries = /^o\d+(?:$|[-.:])/.test(name);
  const stem = prefix ?? (oSeries ? 'o' : name.match(/^[a-z]+(?=\d)/)?.[0] ?? '');
  const remainder = name.slice(stem.length);
  const version = remainder.match(versionNumber);

  // Unknown versioned families retain their namespace. Opaque IDs share a final
  // group so a long catalog does not grow a separate tab for each such model.
  const inferred = version ? (stem + remainder.slice(0, version.index)).replace(/[-_.: ]+$/, '')
    : /[-_:]latest$/.test(name) ? name.replace(/[-_:]latest$/, '') : '';
  const custom = inferred && !uuid.test(name) ? [...path, inferred].join('/') : undefined;
  const key = prefix ?? (oSeries ? 'openai-o' : custom ?? otherKey);
  return {
    key, label: Object.hasOwn(seriesLabels, key) ? seriesLabels[key] : key === otherKey ? '其他' : key,
    version: key !== otherKey && version ? version[1].split(/[.-]/).map(Number) : [],
    omni: key === 'gpt' && /^gpt[- ]?4o(?:$|[-:])/.test(name),
    date: date ? date.slice(1).join('') : '',
    leaf, id,
  };
}

type Order = ReturnType<typeof describeModel>;
function compareModels(a: Order, b: Order): number {
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const delta = (b.version[i] ?? -1) - (a.version[i] ?? -1);
    if (delta) return delta;
  }
  if (a.omni !== b.omni) return a.omni ? -1 : 1;
  if (!!a.date !== !!b.date) return a.date ? 1 : -1;
  return compareNames(b.date, a.date) || compareNames(a.leaf, b.leaf) || compareNames(a.id, b.id);
}

export function groupModelsBySeries<T extends { upstreamId: string }>(models: readonly T[], source?: CatalogSource) {
  const groups = new Map<string, { key: string; label: string; entries: { model: T; order: Order }[] }>();
  const entries = models.map(model => ({ model, order: describeModel(model.upstreamId, source) }));
  const versionedKeys = new Set(entries.filter(entry => entry.order.version.length).map(entry => entry.order.key));
  for (const entry of entries) {
    const { order } = entry;
    // An unnumbered custom alias can still match a versioned sibling, e.g. acme/sonic and acme/sonic-v2.
    const alias = order.id.trim().toLowerCase();
    const key = order.key === otherKey && versionedKeys.has(alias) ? alias : order.key;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: key === order.key ? order.label : key, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  const priority = (key: string) => key === 'gpt' ? 0 : key === 'openai-o' ? 1 : key === otherKey ? 3 : 2;
  return [...groups.values()]
    .sort((a, b) => priority(a.key) - priority(b.key) || compareNames(a.label, b.label))
    .map(({ key, label, entries }) => ({ key, label, models: entries.sort((a, b) => compareModels(a.order, b.order)).map(entry => entry.model) }));
}
