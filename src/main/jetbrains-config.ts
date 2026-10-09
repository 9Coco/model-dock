import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ConfigPreview, Model, Provider, ProviderSecret, ToolBinding } from '../shared/types';
import { bindingConnectionPolicy, resolveBindingModels } from '../shared/bindings';
import { nativeDirectBaseUrl } from '../shared/single-entry';
import { JETBRAINS_TOOLS, type JetBrainsToolId, type JetBrainsStatus } from '../shared/jetbrains';
export type { JetBrainsToolId } from '../shared/jetbrains';

export interface JetBrainsConfigStore {
  listModels(): Model[]; listBindings(): ToolBinding[]; listProviders?(): Provider[]; gatewayKey(): string;
  getProvider?(id: string): Provider | undefined; getSecret?(id: string): ProviderSecret | undefined;
  getManagedState?<T>(key: string, fallback: T): T; setManagedState?(key: string, value: unknown): void;
  createManagedBackup?(kind: string, value: unknown): string;
}
export interface JetBrainsHistoryStore {
  getManagedState<T>(key: string, fallback: T): T; setManagedState(key: string, value: unknown): void; createManagedBackup(kind: string, value: unknown): string;
}
export interface JetBrainsConfigOptions {
  profileRoot?: string; cacheRoot?: string; platform?: NodeJS.Platform; port?: number;
  /** 修改点：仅主进程测试使用，渲染进程不能提供路径或进程检测回调。 */
  processProbe?: (pid: number) => 'running' | 'stopped' | 'unknown';
  beforeCommit?: () => void; afterFileCommit?: (index: number) => void;
}
export type JetBrainsConfigStatus = JetBrainsStatus;
const products = Object.fromEntries(Object.entries(JETBRAINS_TOOLS).map(([id, value]) => [id, { name: value.name, selector: value.selectorPrefix }])) as Record<JetBrainsToolId, { name: string; selector: string }>;
const specs = [
  { file: 'llm.provider.openai.like.xml', component: 'OpenAILikeLlmProviderSettings', fields: ['baseUrl', 'httpClientVersion', 'toolEnabled'] },
  { file: 'llm.custom.models.xml', component: 'LlmCustomModelsSettings', fields: ['smart_model_id', 'quick_model_id'] },
  { file: 'llm.third.party.ai.providers.xml', component: 'LLMThirdPartyAIProvidersSettings', fields: ['OpenAIAPI'] },
] as const;
const maximumFileSize = 512 * 1024;
function fail(message: string): never { throw new Error(`JetBrains ${message}，未修改原配置。`); }
function metadata(path: string) {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function safeDirectory(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    const info = metadata(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) fail('配置目录或父目录为链接或非目录');
    if (dirname(current) === current) break;
  }
}
function readConfig(path: string): string | null {
  safeDirectory(dirname(path)); const info = metadata(path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumFileSize) fail('配置文件类型、链接数或大小不受支持');
  const data = readFileSync(path);
  if (!isUtf8(data)) fail('配置文件不是有效的 UTF-8');
  return data.toString('utf8');
}
function roots(home: string, options: JetBrainsConfigOptions) {
  const platform = options.platform ?? process.platform, realHome = home === homedir();
  const config = platform === 'win32' ? join(realHome && process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'JetBrains')
    : platform === 'darwin' ? join(home, 'Library', 'Application Support', 'JetBrains')
      : join(realHome && process.env.XDG_CONFIG_HOME || join(home, '.config'), 'JetBrains');
  const cache = platform === 'win32' ? join(realHome && process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'JetBrains')
    : platform === 'darwin' ? join(home, 'Library', 'Caches', 'JetBrains')
      : join(realHome && process.env.XDG_CACHE_HOME || join(home, '.cache'), 'JetBrains');
  return { platform, profileRoot: resolve(options.profileRoot ?? config), cacheRoot: resolve(options.cacheRoot ?? cache) };
}
function defaultProcessProbe(pid: number): 'running' | 'stopped' | 'unknown' {
  try { process.kill(pid, 0); return 'running'; }
  catch (error) { const code = (error as NodeJS.ErrnoException).code; return code === 'ESRCH' ? 'stopped' : code === 'EPERM' ? 'running' : 'unknown'; }
}
export function jetBrainsStatus(tool: JetBrainsToolId, homeDirectory = homedir(), options: JetBrainsConfigOptions = {}): JetBrainsConfigStatus {
  const base: JetBrainsConfigStatus = { tool, configDir: null, version: null, foundProfile: false, running: 'unknown', canApply: false, message: '' };
  if (!products[tool]) return { ...base, message: '不支持的 JetBrains 产品。' };
  let located = base;
  try {
    const paths = roots(homeDirectory, options); safeDirectory(paths.profileRoot);
    if (!existsSync(paths.profileRoot)) return { ...base, message: '未发现 IDE 用户配置；先启动 IDE 并安装或启用 AI Assistant，再使用复制接入参数。' };
    const candidates = readdirSync(paths.profileRoot).filter(name => new RegExp(`^${products[tool].selector}(\\d{4}\\.\\d+)(?:\\.\\d+)?$`).test(name));
    candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (!candidates.length) return { ...base, message: '未发现该 IDE 的用户配置；可复制参数到 AI Assistant 的提供商与 API 密钥。' };
    // 修改点：只使用唯一匹配的当前版本；多个配置并存时不猜测用户正在使用哪一个。
    if (candidates.length !== 1) return { ...base, foundProfile: true, message: '发现多个版本的 IDE 配置，无法确认当前配置；请使用复制接入参数。' };
    const selector = candidates[0], configDir = join(paths.profileRoot, selector), version = selector.slice(products[tool].selector.length);
    safeDirectory(configDir); safeDirectory(join(configDir, 'options'));
    const status = { ...base, configDir, version, foundProfile: true }; located = status;
    if (version !== '2026.2') return { ...status, message: '当前版本的配置结构尚未验证；请复制参数，在 IDE 设置中配置。' };
    if (paths.platform !== 'linux' && !options.processProbe) return { ...status, message: '当前平台尚不能可靠确认 IDE 已退出；请复制参数，在 IDE 设置中配置。' };
    const pidPath = join(paths.cacheRoot, selector, '.pid'), pidText = readConfig(pidPath)?.trim();
    if (!pidText || !/^\d{1,10}$/.test(pidText) || !Number.isSafeInteger(Number(pidText)) || Number(pidText) < 1) return { ...status, message: '无法确认 IDE 是否仍运行；请复制参数，在 IDE 设置中配置。' };
    const running = (options.processProbe ?? defaultProcessProbe)(Number(pidText));
    if (running !== 'stopped') return { ...status, running, message: running === 'running' ? 'IDE 记录的进程仍在运行，请先自行退出 IDE 后刷新，再离线同步设置。' : '无法确认 IDE 已退出；请使用复制接入参数。' };
    for (const spec of specs) { const text = readConfig(join(configDir, 'options', spec.file)); if (text !== null) locate(parseXml(text), spec.component); }
    return { ...status, running, canApply: true, message: '已确认该 IDE 进程退出，可离线同步模型与地址；API Key 须在 IDE 中手动填写一次。' };
  } catch { return { ...located, canApply: false, message: '配置路径、XML 或进程检测不安全，离线同步已禁用；请使用复制接入参数。' }; }
}
function selection(store: JetBrainsConfigStore, tool: JetBrainsToolId, port: number, reveal: boolean) {
  if (!products[tool]) fail('产品无效');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('本机入口端口无效');
  const binding = store.listBindings().find(row => row.id === tool);
  if (!binding) fail('缺少工具配置');
  if (!binding.enabled) return null;
  const allModels = store.listModels();
  const providers = store.listProviders?.() ?? (store.getProvider ? [...new Set(binding.providerIds ?? allModels.map(model => model.providerId))].flatMap(id => { const provider = store.getProvider!(id); return provider ? [provider] : []; }) : undefined);
  const models = resolveBindingModels(binding, allModels, providers).filter(model => model.wireApi === 'chat-completions' || model.wireApi === 'responses');
  if (!models.length) fail('请先选择可用的 Chat Completions 或 Responses 模型');
  const core = binding.defaultModelId ? models.find(model => model.id === binding.defaultModelId) : models[0];
  if (!core) fail('默认模型不在所选可用模型中');
  const selectedIds = [...new Set(binding.providerIds ?? models.map(model => model.providerId))];
  if (binding.mode === 'direct' && selectedIds.length !== 1) fail('直连模式必须选择恰好一个原生 API 供应商');
  const policy = bindingConnectionPolicy(binding, allModels, providers), directApi = policy.groups[0]?.connection === 'direct-api';
  const provider = store.getProvider?.(selectedIds[0]) ?? providers?.find(item => item.id === selectedIds[0]);
  if (binding.mode === 'direct' && (!directApi || !provider || !nativeDirectBaseUrl(tool, provider, models))) fail('直连来源不支持 Chat Completions；请使用聚合接口');
  const modelId = (model: Model) => directApi ? model.upstreamId : model.alias;
  if (models.some(model => !modelId(model).trim() || /[\x00-\x1f\x7f]/.test(modelId(model)))) fail(directApi ? '模型标识无效' : '模型别名无效');
  const key = directApi ? reveal ? store.getSecret?.(provider!.id)?.apiKey : '__PROVIDER_API_KEY__' : reveal ? store.gatewayKey() : '__MODELDOCK_LOCAL_KEY__';
  if (!key || typeof key !== 'string') fail(directApi ? '直连供应商尚未填写 API Key' : '本机入口密钥无效');
  const baseUrl = directApi ? nativeDirectBaseUrl(tool, provider!, models)! : `http://127.0.0.1:${port}/tool/${tool}/v1`;
  if (!baseUrl) fail('直连供应商地址为空');
  return { models, core, key, baseUrl, directApi, coreId: modelId(core), modelId };
}
export function buildJetBrainsConfig(store: JetBrainsConfigStore, tool: JetBrainsToolId, port: number, revealKey = false, homeDirectory = homedir(), options: JetBrainsConfigOptions = {}): ConfigPreview {
  const selected = selection(store, tool, port, revealKey), status = jetBrainsStatus(tool, homeDirectory, options);
  return { filename: `modeldock-${tool}-connection-guide.json`, canApply: status.canApply,
    content: JSON.stringify(selected ? { tool: products[tool].name, provider: 'OpenAI-compatible', baseUrl: selected.baseUrl, apiKey: selected.key, httpVersion: 'HTTP/1.1', toolCalling: selected.core.tools,
      models: selected.models.map(model => ({ id: selected.modelId(model), name: model.displayName || selected.modelId(model), wireApi: 'chat-completions' })), modelAssignment: { core: `OpenAIAPI/${selected.coreId}`, lightweight: `OpenAIAPI/${selected.coreId}` },
    } : {}, null, 2),
    instructions: '此 JSON 是接入参数说明，不能作为 IDE 原生配置导入。打开 设置 → 工具 → AI Assistant → 提供商与 API 密钥，选择兼容 OpenAI，填写 URL 与' + (selected?.directApi ? '供应商 API Key' : '本机 API Key') + '，使用 HTTP/1.1，然后测试连接并在模型指定中选择核心功能和即时助手。'
      + '模型聊天在 IDE 的模型选择器中切换。工具调用只在模型支持时勾选；JetBrains 订阅、Junie、Claude Agent、Codex 和 Gemini CLI 的授权使用各自入口。'
      + '离线同步仅调整本产品已验证的地址、HTTP 版本、核心功能与即时助手模型、工具调用开关，并启用 OpenAIAPI；保留其他模型、提供商和设置。API Key 由 IDE 的 PasswordSafe 管理，必须在 IDE 中手动粘贴一次，本软件不写密码库或 OAuth 凭据。'
      + (selected?.directApi ? '当前直接连接所选单一 API 来源，模型使用真实上游 ID；预览隐藏 API Key，显式复制或导出接入参数才读取该供应商密钥。' : '当前使用 ModelDock 聚合接口；内部可选择供应商及允许映射的模型。Responses 模型和订阅由聚合入口转换为 IDE 使用的 Chat Completions 协议；只把固定本机密钥交给 IDE，OAuth 凭据留在主进程。使用时保持 ModelDock 本机入口运行。')
      + '协议桥与模型清单不代表真实 IDE 或上游推理验收。' + status.message,
  };
}

// 修改点：严格解析 XML 并记录原文偏移，只点改托管节点，不重新序列化整份 XML。
interface Attribute { value: string; start: number; end: number; quote: string }
interface XmlNode { name: string; attrs: Map<string, Attribute>; children: XmlNode[]; start: number; openEnd: number; closeStart: number; end: number; selfClosing: boolean }
interface XmlDoc { text: string; root: XmlNode }
function unescapeXml(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/.test(value)) fail('XML 含无效实体');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, entity: string) => {
    const predefined: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (predefined[entity]) return predefined[entity];
    const n = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    if (!(n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0xd7ff || n >= 0xe000 && n <= 0xfffd || n >= 0x10000 && n <= 0x10ffff)) fail('XML 含无效字符');
    return String.fromCodePoint(n);
  });
}
function escapeXml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function parseXml(text: string): XmlDoc {
  if (Buffer.byteLength(text, 'utf8') > maximumFileSize || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) fail('XML 大小或字符无效');
  const stack: XmlNode[] = []; let root: XmlNode | undefined, i = text.charCodeAt(0) === 0xfeff ? 1 : 0, declaration = false;
  while (i < text.length) {
    if (text[i] !== '<') {
      const end = text.indexOf('<', i), next = end < 0 ? text.length : end, value = text.slice(i, next);
      if (!stack.length && value.trim() || value.includes(']]>')) fail('XML 根节点外存在内容');
      unescapeXml(value); i = next; continue;
    }
    if (text.startsWith('<!--', i)) { const end = text.indexOf('-->', i + 4); if (end < 0 || text.slice(i + 4, end).includes('--')) fail('XML 注释无效'); i = end + 3; continue; }
    if (text.startsWith('<![CDATA[', i)) { const end = text.indexOf(']]>', i + 9); if (end < 0 || !stack.length) fail('XML CDATA 无效'); i = end + 3; continue; }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end < 0 || i !== (text.charCodeAt(0) === 0xfeff ? 1 : 0) || root || declaration || !/^<\?xml\s+version\s*=\s*(["'])1\.0\1(?:\s+encoding\s*=\s*(["'])UTF-8\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*\?>$/i.test(text.slice(i, end + 2))) fail('XML 声明不受支持');
      declaration = true; i = end + 2; continue;
    }
    if (text.startsWith('<!', i)) fail('XML 不允许 DTD 或实体声明');
    const closing = text.startsWith('</', i), match = /^<\/?([A-Za-z_][\w.:-]*)/.exec(text.slice(i));
    if (!match) fail('XML 标签无效');
    const name = match[1]; let cursor = i + match[0].length;
    if (closing) {
      const tail = /^\s*>/.exec(text.slice(cursor)), node = stack.pop();
      if (!tail || !node || node.name !== name) fail('XML 标签不匹配');
      node.closeStart = i; node.end = cursor + tail[0].length; i = node.end; continue;
    }
    const attrs = new Map<string, Attribute>();
    while (!/^\s*\/?>/.test(text.slice(cursor))) {
      const attr = /^(\s+)([A-Za-z_][\w.:-]*)(\s*=\s*)(["'])([^]*?)\4/.exec(text.slice(cursor));
      if (!attr || attrs.has(attr[2]) || attr[5].includes('<')) fail('XML 属性无效或重复');
      const start = cursor + attr[1].length + attr[2].length + attr[3].length + 1;
      attrs.set(attr[2], { value: unescapeXml(attr[5]), start, end: start + attr[5].length, quote: attr[4] }); cursor += attr[0].length;
    }
    const tail = /^\s*(\/?)>/.exec(text.slice(cursor))!; const openEnd = cursor + tail[0].length;
    const node: XmlNode = { name, attrs, children: [], start: i, openEnd, closeStart: openEnd, end: openEnd, selfClosing: !!tail[1] };
    if (stack.length) stack[stack.length - 1].children.push(node); else { if (root) fail('XML 有多个根节点'); root = node; }
    if (!node.selfClosing) stack.push(node); i = openEnd;
  }
  if (!root || root.name !== 'application' || stack.length) fail('XML 不是完整的 application 配置');
  return { text, root };
}
function locate(doc: XmlDoc, component: string): XmlNode | undefined {
  const nodes = doc.root.children.filter(node => node.name === 'component' && node.attrs.get('name')?.value === component);
  if (nodes.length > 1) fail('托管 component 重复');
  return nodes[0];
}
function option(doc: XmlDoc, component: string, name: string): XmlNode | undefined {
  const nodes = locate(doc, component)?.children.filter(node => node.name === 'option' && node.attrs.get('name')?.value === name) ?? [];
  if (nodes.length > 1) fail('托管 option 重复'); return nodes[0];
}
function onlyWhitespaceAndComments(doc: XmlDoc, node: XmlNode): boolean {
  return !doc.text.slice(node.openEnd, node.closeStart).replace(/<!--[^]*?-->/g, '').trim();
}
interface Value { present: boolean; value?: string }
function valueOf(doc: XmlDoc, component: string, name: string): Value {
  const node = option(doc, component, name);
  if (!node) return { present: false };
  if (node.children.length || !onlyWhitespaceAndComments(doc, node) || !node.attrs.has('value')) fail('托管模型字段不是简单值');
  return { present: true, value: node.attrs.get('value')!.value };
}
function enabledNode(doc: XmlDoc, component: string): { container?: XmlNode; member?: XmlNode } {
  const container = option(doc, component, 'enabledThirdPartyAIProviders');
  if (!container) return {};
  let directText = doc.text.slice(container.openEnd, container.closeStart);
  for (const child of [...container.children].reverse()) directText = directText.slice(0, child.start - container.openEnd) + directText.slice(child.end - container.openEnd);
  if (directText.replace(/<!--[^]*?-->/g, '').trim() || container.attrs.has('value') || container.children.some(node => node.name !== 'option' || !node.attrs.has('value') || node.children.length || !onlyWhitespaceAndComments(doc, node))) fail('启用提供商列表结构不受支持');
  const members = container.children.filter(node => node.attrs.get('value')!.value === 'OpenAIAPI');
  if (members.length > 1) fail('启用提供商重复'); return { container, member: members[0] };
}
function fieldValue(doc: XmlDoc, spec: typeof specs[number], name: string): Value {
  return name === 'OpenAIAPI' ? { present: true, value: enabledNode(doc, spec.component).member ? 'true' : 'false' } : valueOf(doc, spec.component, name);
}
function equal(a: Value, b: Value): boolean { return a.present === b.present && a.value === b.value; }
function insertChild(doc: XmlDoc, parent: XmlNode, xml: string): string {
  if (parent.selfClosing) { const start = doc.text.lastIndexOf('/', parent.openEnd - 1); return doc.text.slice(0, start) + `>\n${xml}\n</${parent.name}>` + doc.text.slice(parent.end); }
  return doc.text.slice(0, parent.closeStart) + `\n${xml}\n` + doc.text.slice(parent.closeStart);
}
function ensureComponent(text: string, name: string): string {
  const doc = parseXml(text); return locate(doc, name) ? text : insertChild(doc, doc.root, `  <component name="${name}">\n  </component>`);
}
function removeNode(doc: XmlDoc, node: XmlNode): string {
  const comments = doc.text.slice(node.start, node.end).match(/<!--[^]*?-->/g)?.join('') ?? '';
  return doc.text.slice(0, node.start) + comments + doc.text.slice(node.end);
}
function patchField(text: string, spec: typeof specs[number], name: string, value: Value): string {
  let doc = parseXml(text);
  if (name === 'OpenAIAPI') {
    let { container, member } = enabledNode(doc, spec.component);
    if (value.value === 'false') {
      // 修改点：提供商成员的额外属性或评论属于用户后续修改，不能随启用标记删除。
      // 我们只生成 value 属性和空内容；恢复仅删除仍符合这份最小结构的成员。
      if (!member || member.attrs.size !== 1 || !member.attrs.has('value') || member.children.length
        || doc.text.slice(member.openEnd, member.closeStart).trim()) return text;
      return removeNode(doc, member);
    }
    if (member) return text;
    text = ensureComponent(text, spec.component); doc = parseXml(text); ({ container } = enabledNode(doc, spec.component));
    if (!container) return insertChild(doc, locate(doc, spec.component)!, '    <option name="enabledThirdPartyAIProviders">\n      <option value="OpenAIAPI" />\n    </option>');
    return insertChild(doc, container, '      <option value="OpenAIAPI" />');
  }
  const node = option(doc, spec.component, name);
  if (!value.present) {
    // 删除新建字段时，用户添加的额外属性属于外部修改，不随托管字段删除。
    if (node && [...node.attrs.keys()].some(key => !['name', 'value'].includes(key))) return text;
    return node ? removeNode(doc, node) : text;
  }
  if (node) { valueOf(doc, spec.component, name); const attr = node.attrs.get('value')!; return text.slice(0, attr.start) + escapeXml(value.value!) + text.slice(attr.end); }
  text = ensureComponent(text, spec.component); doc = parseXml(text);
  return insertChild(doc, locate(doc, spec.component)!, `    <option name="${name}" value="${escapeXml(value.value!)}" />`);
}
interface FieldHistory { before: Value; applied: Value }
interface FileHistory { file: string; before: string | null; after: string | null; whole: boolean; fields: Record<string, FieldHistory> }
interface History { version: 1; tool: JetBrainsToolId; target: string; files: FileHistory[] }
interface Change { file: string; original: string | null; content: string | null }
interface Pending { version: 1; tool: JetBrainsToolId; target: string; pending: { previous: History | null; next: History | null; changes: Change[] } }
function record(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validValue(value: unknown): value is Value { return record(value) && typeof value.present === 'boolean' && Object.keys(value).every(key => ['present', 'value'].includes(key)) && (value.present ? typeof value.value === 'string' : value.value === undefined); }
export function jetBrainsHistoryKey(target: string, tool: JetBrainsToolId): string { return `tool-config:${tool}:${createHash('sha256').update(resolve(target)).digest('hex')}`; }
function validateHistory(value: unknown, tool: JetBrainsToolId, target: string): History | null {
  if (value === null) return null;
  if (!record(value) || value.version !== 1 || value.tool !== tool || value.target !== target || !Array.isArray(value.files) || value.files.length !== specs.length) fail('恢复记录无效');
  for (const [index, row] of value.files.entries()) {
    const spec = specs[index];
    if (!record(row) || row.file !== spec.file || typeof row.whole !== 'boolean' || ![row.before, row.after].every(item => item === null || typeof item === 'string') || !record(row.fields)
      || spec.fields.some(name => !Object.hasOwn(row.fields, name)) || Object.keys(row.fields).some(name => !(spec.fields as readonly string[]).includes(name)) || Object.values(row.fields).some(field => !record(field) || !validValue(field.before) || !validValue(field.applied))) fail('恢复记录无效');
    for (const text of [row.before, row.after]) if (text !== null) parseXml(text);
  }
  return value as unknown as History;
}
function historyStore(store: Partial<JetBrainsHistoryStore>): JetBrainsHistoryStore {
  if (!store.getManagedState || !store.setManagedState || !store.createManagedBackup) fail('同步需要加密恢复记录与加密备份存储');
  return store as JetBrainsHistoryStore;
}
function readHistory(store: ReturnType<typeof historyStore>, tool: JetBrainsToolId, target: string): History | null | Pending {
  const value = store.getManagedState<unknown>(jetBrainsHistoryKey(target, tool), null);
  if (!record(value) || !Object.hasOwn(value, 'pending')) return validateHistory(value, tool, target);
  if (value.version !== 1 || value.tool !== tool || value.target !== target || !record(value.pending) || !Array.isArray(value.pending.changes) || value.pending.changes.length > specs.length) fail('事务恢复记录无效');
  validateHistory(value.pending.previous, tool, target); validateHistory(value.pending.next, tool, target);
  const names = new Set<string>();
  for (const change of value.pending.changes) {
    if (!record(change) || !specs.some(spec => spec.file === change.file) || names.has(change.file) || ![change.original, change.content].every(item => item === null || typeof item === 'string')) fail('事务恢复记录无效');
    names.add(change.file); for (const text of [change.original, change.content]) if (text !== null) parseXml(text);
  }
  return value as unknown as Pending;
}
function replaceFile(path: string, text: string | null): void {
  safeDirectory(dirname(path)); if (text === null) { if (metadata(path)) unlinkSync(path); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.modeldock-${randomUUID()}.tmp`;
  try { writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function stopped(tool: JetBrainsToolId, home: string, options: JetBrainsConfigOptions, target?: string): JetBrainsConfigStatus {
  const status = jetBrainsStatus(tool, home, options);
  if (!status.canApply || !status.configDir || target && target !== status.configDir) throw new Error(status.message || 'JetBrains 配置路径已经变化。');
  return status;
}
function recover(store: ReturnType<typeof historyStore>, tool: JetBrainsToolId, target: string, history: History | null | Pending, home: string, options: JetBrainsConfigOptions): History | null {
  if (!history || !('pending' in history)) return history;
  const { previous, changes } = history.pending;
  for (const change of changes) { const text = readConfig(join(target, 'options', change.file)); if (text !== change.original && text !== change.content) fail('未完成事务遇到外部修改，请保留备份并手动检查'); }
  for (const change of [...changes].reverse()) {
    stopped(tool, home, options, target);
    const path = join(target, 'options', change.file), current = readConfig(path);
    if (current !== change.original && current !== change.content) fail('事务恢复期间配置被其他程序修改');
    if (current === change.content && current !== change.original) replaceFile(path, change.original);
  }
  store.setManagedState(jetBrainsHistoryKey(target, tool), previous); return previous;
}
function transact(store: ReturnType<typeof historyStore>, tool: JetBrainsToolId, target: string, backups: string, before: History | null, after: History | null, changes: Change[], home: string, options: JetBrainsConfigOptions): string {
  const changed = changes.filter(change => change.original !== change.content), key = jetBrainsHistoryKey(target, tool);
  if (!changed.length && JSON.stringify(before) === JSON.stringify(after)) return target;
  safeDirectory(backups); mkdirSync(backups, { recursive: true, mode: 0o700 });
  const stamp = `${Date.now()}-${randomUUID()}`;
  for (const change of changed) if (change.original !== null) {
    const backup = join(backups, `${tool}-${stamp}-${change.file}.bak`);
    writeFileSync(backup, change.original, { mode: 0o600, flag: 'wx' }); chmodSync(backup, 0o600);
    if (readFileSync(backup, 'utf8') !== change.original) fail('备份验证失败');
  }
  const journal: Pending = { version: 1, tool, target, pending: { previous: before, next: after, changes: changed } };
  if (Buffer.byteLength(JSON.stringify(journal), 'utf8') > 7 * 1024 * 1024) fail('事务记录过大');
  store.createManagedBackup('jetbrains-sync', journal);
  let journalWritten = false; const committed: Change[] = [];
  try {
    options.beforeCommit?.(); stopped(tool, home, options, target);
    if (changes.some(change => readConfig(join(target, 'options', change.file)) !== change.original) || JSON.stringify(readHistory(store, tool, target)) !== JSON.stringify(before)) fail('配置刚被其他程序修改，请重新预览');
    journalWritten = true; store.setManagedState(key, journal);
    for (const [index, change] of changed.entries()) {
      stopped(tool, home, options, target); const path = join(target, 'options', change.file);
      if (readConfig(path) !== change.original) fail('配置刚被其他程序修改');
      replaceFile(path, change.content); committed.push(change); options.afterFileCommit?.(index);
    }
    if (changes.some(change => readConfig(join(target, 'options', change.file)) !== change.content)) fail('写入验证失败');
    store.setManagedState(key, after); return target;
  } catch (error) {
    try {
      for (const change of [...committed].reverse()) {
        stopped(tool, home, options, target);
        const path = join(target, 'options', change.file); if (readConfig(path) !== change.content) throw new Error('External changes'); replaceFile(path, change.original);
      }
      if (journalWritten) store.setManagedState(key, before);
    } catch { throw new Error('JetBrains 同步未完成，回滚遇到外部修改或存储错误；原文件及加密事务备份已保留。'); }
    throw error;
  }
}
function restoreChanges(history: History, target: string): Change[] {
  return specs.map((spec, index) => {
    const saved = history.files[index], path = join(target, 'options', spec.file), original = readConfig(path);
    if (original === saved.after && saved.whole) return { file: spec.file, original, content: saved.before };
    if (original === null) return { file: spec.file, original, content: null };
    let content = original;
    for (const [name, field] of Object.entries(saved.fields)) if (equal(fieldValue(parseXml(content), spec, name), field.applied)) content = patchField(content, spec, name, field.before);
    parseXml(content); return { file: spec.file, original, content };
  });
}
export function applyJetBrainsConfig(store: JetBrainsConfigStore, tool: JetBrainsToolId, backups: string, homeDirectory = homedir(), options: JetBrainsConfigOptions = {}): string {
  const stateStore = historyStore(store), status = stopped(tool, homeDirectory, options), target = status.configDir!;
  const history = recover(stateStore, tool, target, readHistory(stateStore, tool, target), homeDirectory, options), selected = selection(store, tool, options.port ?? 18181, false);
  if (!selected) return history ? transact(stateStore, tool, target, backups, history, null, restoreChanges(history, target), homeDirectory, options) : target;
  const next: History = { version: 1, tool, target, files: [] }, changes: Change[] = [];
  for (const [index, spec] of specs.entries()) {
    const original = readConfig(join(target, 'options', spec.file)); let content = original ?? '<application>\n</application>\n';
    const prior = history?.files[index], fields: Record<string, FieldHistory> = {};
    const desired: Record<string, Value> = index === 0 ? { baseUrl: { present: true, value: selected.baseUrl }, httpClientVersion: { present: true, value: 'HTTP_1_1' }, toolEnabled: { present: true, value: String(selected.core.tools) } }
      : index === 1 ? { smart_model_id: { present: true, value: `OpenAIAPI/${selected.coreId}` }, quick_model_id: { present: true, value: `OpenAIAPI/${selected.coreId}` } }
        : { OpenAIAPI: { present: true, value: 'true' } };
    for (const [name, applied] of Object.entries(desired)) {
      const current = fieldValue(parseXml(content), spec, name), previous = prior?.fields[name];
      fields[name] = { before: previous && equal(current, previous.applied) ? previous.before : current, applied }; content = patchField(content, spec, name, applied);
    }
    parseXml(content); next.files.push({ file: spec.file, before: prior ? prior.before : original, after: content, whole: prior ? prior.whole && original === prior.after : true, fields });
    changes.push({ file: spec.file, original, content });
  }
  return transact(stateStore, tool, target, backups, history, next, changes, homeDirectory, options);
}
export function restoreJetBrainsConfig(store: JetBrainsHistoryStore, tool: JetBrainsToolId, backups: string, homeDirectory = homedir(), options: JetBrainsConfigOptions = {}): string {
  const stateStore = historyStore(store), status = stopped(tool, homeDirectory, options), target = status.configDir!;
  const history = recover(stateStore, tool, target, readHistory(stateStore, tool, target), homeDirectory, options);
  return history ? transact(stateStore, tool, target, backups, history, null, restoreChanges(history, target), homeDirectory, options) : target;
}
