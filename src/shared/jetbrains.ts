export const JETBRAINS_TOOLS = {
  webstorm: { name: 'WebStorm', selectorPrefix: 'WebStorm' },
  'intellij-idea': { name: 'IntelliJ IDEA', selectorPrefix: 'IntelliJIdea' },
  rider: { name: 'Rider', selectorPrefix: 'Rider' },
  pycharm: { name: 'PyCharm', selectorPrefix: 'PyCharm' },
} as const;
export type JetBrainsToolId = keyof typeof JETBRAINS_TOOLS;
export const JETBRAINS_TOOL_IDS = Object.keys(JETBRAINS_TOOLS) as JetBrainsToolId[];
export function isJetBrainsTool(value: unknown): value is JetBrainsToolId {
  return typeof value === 'string' && Object.hasOwn(JETBRAINS_TOOLS, value);
}
/** 修改点：未确认 IDE 退出时只提供接入参数，不写正在运行的设置文件。 */
export interface JetBrainsStatus {
  tool: JetBrainsToolId;
  configDir: string | null;
  version: string | null;
  foundProfile: boolean;
  running: 'running' | 'stopped' | 'unknown';
  canApply: boolean;
  message: string;
}
export const JETBRAINS_SETTINGS_PATH = '设置 → 工具 → AI Assistant → 提供商与 API 密钥';
/** Separate tool-scoped permissions even though the IDEs share an Assistant schema. */
export function jetBrainsBaseUrl(tool: JetBrainsToolId, port: number): string {
  return `http://127.0.0.1:${port}/tool/${tool}/v1`;
}
