import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseToml } from '@iarna/toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { McpManager, type McpStore } from '../src/main/mcp';
import { MCP_SECRET_PLACEHOLDER } from '../src/shared/mcp-types';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error('Unexpected test target'); rmSync(root, { recursive: true, force: true }); } });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'modeldock-mcp-')); roots.push(root);
  const states = new Map<string, unknown>();
  const store: McpStore = { getManagedState: <T>(key: string, fallback: T) => (states.get(key) ?? fallback) as T, setManagedState: (key, value) => { states.set(key, JSON.parse(JSON.stringify(value))); } };
  const manager = new McpManager(store, { homeDir: root, appDataDir: root, backupDir: join(root, 'backups') });
  return { root, manager, states };
}
function local(manager: McpManager, enabledTools: ('codex' | 'opencode' | 'vscode' | 'copilot' | 'dsh')[] = ['codex']) {
  return manager.save({ name: 'test-server', transport: 'stdio', command: 'npx', args: ['-y', 'example-mcp'], enabledTools });
}
describe('MCP management', () => {
  it('saves globally and toggles tool selections without modifying native files', () => {
    const { root, manager } = setup(); const item = local(manager);
    manager.setToolEnabled(item.id, 'vscode', true); expect(manager.list()[0].enabledTools).toEqual(['codex', 'vscode']);
    expect(existsSync(join(root, '.codex', 'config.toml'))).toBe(false);
    manager.remove(item.id); expect(manager.list()).toHaveLength(0);
  });
  it('imports Codex without writing and never returns imported env/header credentials', () => {
    const { root, manager } = setup(); mkdirSync(join(root, '.codex'));
    const original = '[mcp_servers.private]\ncommand="server"\nargs=[]\nstartup_timeout_sec=25\nenv={API_KEY="secret-env"}\n[mcp_servers.remote]\nurl="https://example.com/mcp"\nhttp_headers={Authorization="Bearer secret-header"}\n';
    writeFileSync(join(root, '.codex', 'config.toml'), original);
    const imported = manager.importFromTool('codex'); expect(imported.imported).toBe(2);
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toBe(original);
    const safe = JSON.stringify(manager.list()) + JSON.stringify(imported) + JSON.stringify(manager.preview('codex'));
    expect(safe).not.toContain('secret-env'); expect(safe).not.toContain('secret-header');
    expect(manager.list()[0].redactedEnvKeys).toEqual(['API_KEY']);
    const preview = manager.preview('codex'); expect(preview.conflicts).toEqual([]); manager.apply('codex', preview.fingerprint);
    const data = parseToml(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')) as any;
    expect(data.mcp_servers.private.env.API_KEY).toBe('secret-env'); expect(data.mcp_servers.private.startup_timeout_sec).toBe(25);
    expect(data.mcp_servers.remote.http_headers.Authorization).toBe('Bearer secret-header');
  });
  it('retains blank edited secrets, supports explicit deletion, and does not reveal unrelated native config', () => {
    const { root, manager } = setup(); mkdirSync(join(root, '.config', 'opencode'), { recursive: true });
    const filename = join(root, '.config', 'opencode', 'opencode.jsonc');
    writeFileSync(filename, '{// keep this comment\n"provider":{"other":{"apiKey":"unrelated-secret"}},"mcp":{"local":{"type":"local","command":["server"],"environment":{"TOKEN":"env-secret"}},"remote":{"type":"remote","url":"https://example.com/mcp","headers":{"Authorization":"header-secret"},"oauth":{"clientSecret":"oauth-secret"}}}}');
    manager.importFromTool('opencode'); const first = manager.list().find(s => s.name === 'local')!;
    manager.save({ ...first, env: { TOKEN: '', EXTRA: 'extra-secret' } });
    const remote = manager.list().find(s => s.name === 'remote')!; manager.save({ ...remote, headers: { Authorization: '', Added: 'new-header' } });
    const preview = manager.preview('opencode'); const safe = JSON.stringify(preview);
    for (const secret of ['unrelated-secret', 'env-secret', 'extra-secret', 'header-secret', 'oauth-secret', 'new-header']) expect(safe).not.toContain(secret);
    manager.apply('opencode', preview.fingerprint);
    const written = parseJsonc(readFileSync(filename, 'utf8'));
    expect(written.mcp.local.environment).toEqual({ TOKEN: 'env-secret', EXTRA: 'extra-secret' });
    expect(written.mcp.remote.headers).toEqual({ Authorization: 'header-secret', Added: 'new-header' });
    expect(written.mcp.remote.oauth.clientSecret).toBe('oauth-secret');
    expect(written.provider.other.apiKey).toBe('unrelated-secret'); expect(readFileSync(filename, 'utf8')).toContain('// keep this comment');
    manager.save({ ...first, deleteEnvKeys: ['TOKEN'] }); manager.apply('opencode');
    expect(parseJsonc(readFileSync(filename, 'utf8')).mcp.local.environment.TOKEN).toBeUndefined();
  });
  it('merges JSONC, backs up original files and preserves other MCP entries', () => {
    const { root, manager } = setup(); mkdirSync(join(root, 'Code', 'User'), { recursive: true });
    const filename = join(root, 'Code', 'User', 'mcp.json'); const original = '{// hello\n"inputs":[{"id":"token","type":"promptString"}],"servers":{"keep":{"type":"stdio","command":"keep"}}}'; writeFileSync(filename, original);
    local(manager, ['vscode']); const result = manager.apply('vscode');
    expect(result.backupPath).toBeTruthy(); expect(readFileSync(result.backupPath!, 'utf8')).toBe(original);
    const written = readFileSync(filename, 'utf8'); expect(written).toContain('// hello'); expect(parseJsonc(written).servers.keep.command).toBe('keep'); expect(parseJsonc(written).inputs).toHaveLength(1);
    expect(manager.apply('vscode').changed).toBe(false); expect(readdirSync(join(root, 'backups'))).toHaveLength(1);
  });
  it('keeps unrelated Codex TOML settings/comments and merges quoted MCP names and nested tables', () => {
    const { root, manager } = setup(); mkdirSync(join(root, '.codex')); const filename = join(root, '.codex', 'config.toml');
    writeFileSync(filename, '# user settings\nmodel = "existing" # model comment\n[mcp_servers."quoted.name"]\ncommand="server"\n[mcp_servers."quoted.name".env]\nAPI_KEY="token"\n[model_providers.other]\n# provider comment\nname="Other"\n');
    manager.importFromTool('codex'); const imported = manager.list()[0]; manager.save({ ...imported, command: 'new-command' }); manager.apply('codex');
    const contents = readFileSync(filename, 'utf8'); const parsed = parseToml(contents) as any;
    expect(contents).toContain('# user settings'); expect(contents).toContain('# model comment'); expect(contents).toContain('# provider comment');
    expect(parsed.model).toBe('existing'); expect(parsed.model_providers.other.name).toBe('Other'); expect(parsed.mcp_servers['quoted.name'].env.API_KEY).toBe('token');
    manager.remove(imported.id); manager.apply('codex'); expect((parseToml(readFileSync(filename, 'utf8')) as any).mcp_servers?.['quoted.name']).toBeUndefined();
  });
  it('refuses same-name unmanaged overwrite and refuses manually changed managed deletions/updates', () => {
    const { root, manager } = setup(); mkdirSync(join(root, '.copilot'));
    const filename = join(root, '.copilot', 'mcp-config.json'); writeFileSync(filename, '{"mcpServers":{"test-server":{"type":"local","command":"other","args":[],"tools":["*"]}}}');
    const item = local(manager, ['copilot']); expect(manager.preview('copilot').canApply).toBe(false); expect(() => manager.apply('copilot')).toThrow('非受管');
    writeFileSync(filename, '{}'); manager.apply('copilot');
    const data = JSON.parse(readFileSync(filename, 'utf8')); data.mcpServers['test-server'].args.push('manual'); writeFileSync(filename, JSON.stringify(data));
    manager.save({ ...item, command: 'updated' }); expect(() => manager.apply('copilot')).toThrow('已被修改');
    manager.remove(item.id); expect(() => manager.apply('copilot')).toThrow('拒绝删除'); expect(JSON.parse(readFileSync(filename, 'utf8')).mcpServers['test-server'].args).toContain('manual');
  });
  it('removes disabled/deleted unchanged managed entries only on explicit apply', () => {
    const { root, manager } = setup(); const item = local(manager, ['opencode']); manager.apply('opencode');
    const filename = join(root, '.config', 'opencode', 'opencode.json');
    const data = JSON.parse(readFileSync(filename, 'utf8')); data.mcp.keep = { type: 'local', command: ['keep'] }; writeFileSync(filename, JSON.stringify(data));
    manager.setToolEnabled(item.id, 'opencode', false); expect(JSON.parse(readFileSync(filename, 'utf8')).mcp['test-server']).toBeTruthy();
    expect(manager.preview('opencode').removals).toEqual(['test-server']); manager.apply('opencode');
    expect(JSON.parse(readFileSync(filename, 'utf8')).mcp).toEqual({ keep: { type: 'local', command: ['keep'] } });
  });
  it('detects changes after preview, malformed files, locks and transport capability boundaries', () => {
    const { root, manager } = setup(); local(manager, ['copilot']); const preview = manager.preview('copilot'); mkdirSync(join(root, '.copilot'));
    const filename = join(root, '.copilot', 'mcp-config.json'); writeFileSync(filename, '{"other":true}'); expect(() => manager.apply('copilot', preview.fingerprint)).toThrow('预览后发生变化');
    writeFileSync(filename, '{broken'); expect(() => manager.preview('copilot')).toThrow('格式有误'); expect(readFileSync(filename, 'utf8')).toBe('{broken');
    writeFileSync(filename, '{}'); writeFileSync(filename + '.modeldock.lock', 'locked'); expect(() => manager.apply('copilot')).toThrow('其他 ModelDock');
    manager.save({ name: 'legacy', transport: 'sse', url: 'https://example.com/sse', enabledTools: ['codex', 'vscode', 'opencode'] });
    expect(manager.preview('codex').canApply).toBe(false); expect(manager.preview('vscode').content).toContain('"sse"'); expect(manager.preview('opencode').content).toContain('"remote"');
    expect(manager.preview('dsh').canApply).toBe(false); expect(() => manager.apply('dsh')).toThrow('仅支持导出');
  });
  it('does not overwrite existing global record when imported same-name native config differs', () => {
    const { root, manager } = setup(); local(manager, ['codex']); mkdirSync(join(root, '.copilot'));
    writeFileSync(join(root, '.copilot', 'mcp-config.json'), '{"mcpServers":{"test-server":{"type":"local","command":"different","args":[],"env":{"KEY":"secret"}}}}');
    const result = manager.importFromTool('copilot'); expect(result.skipped).toBe(1); expect(result.warnings[0]).toContain('不同'); expect(manager.list()[0].command).toBe('npx'); expect(manager.list()[0].enabledTools).toEqual(['codex']);
  });
  it('rejects dangerous names and invalid configuration inputs', () => {
    const { manager } = setup(); expect(() => manager.save({ name: '__proto__', transport: 'stdio', command: 'x', enabledTools: [] })).toThrow('名称');
    expect(() => manager.save({ name: 'bad', transport: 'http', url: 'https://user:secret@example.com/mcp', enabledTools: [] })).toThrow('凭据');
    expect(() => manager.save({ name: 'bad', transport: 'stdio', command: 'x', args: [12 as any], enabledTools: [] })).toThrow('数组');
  });
  it('redacts credential arguments/query strings from snapshots/previews and preserves original values on edited apply', () => {
    const { root, manager } = setup();
    const args = ['--token', 'arg-token-secret', '--api-key=arg-api-secret', 'PASSWORD=arg-pass-secret', '--client-secret', 'arg-client-secret', '--normal', 'visible', '--url=https://example.com/mcp?token=nested-url-secret'];
    const saved = manager.save({ name: 'credential-args', transport: 'stdio', command: 'C:\\Program Files\\MCP\\server.exe', args, enabledTools: ['opencode', 'codex'] });
    const remote = manager.save({ name: 'credential-url', transport: 'http', url: 'https://example.com/mcp?api_key=url-secret&access_token=token-secret&visible=value', enabledTools: ['copilot'] });
    const rendered = JSON.stringify(manager.list()) + JSON.stringify(manager.preview('opencode')) + JSON.stringify(manager.preview('codex')) + JSON.stringify(manager.preview('copilot'));
    for (const secret of ['arg-token-secret', 'arg-api-secret', 'arg-pass-secret', 'arg-client-secret', 'url-secret', 'token-secret', 'nested-url-secret']) expect(rendered).not.toContain(secret);
    expect(saved.args[1]).toBe(MCP_SECRET_PLACEHOLDER); expect(saved.args[2]).toBe('--api-key=' + MCP_SECRET_PLACEHOLDER); expect(saved.args[3]).toBe('PASSWORD=' + MCP_SECRET_PLACEHOLDER);
    expect(saved.command).toBe('C:\\Program Files\\MCP\\server.exe'); expect(remote.url).toContain('visible=value');
    manager.save({ ...saved, description: 'edited without changing secrets' }); manager.save({ ...remote, description: 'edited' });
    manager.apply('opencode'); manager.apply('codex'); manager.apply('copilot');
    expect(parseJsonc(readFileSync(join(root, '.config', 'opencode', 'opencode.json'), 'utf8')).mcp['credential-args'].command).toEqual(['C:\\Program Files\\MCP\\server.exe', ...args]);
    expect((parseToml(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')) as any).mcp_servers['credential-args'].args).toEqual(args);
    const writtenUrl = JSON.parse(readFileSync(join(root, '.copilot', 'mcp-config.json'), 'utf8')).mcpServers['credential-url'].url;
    expect(new URL(writtenUrl).searchParams.get('api_key')).toBe('url-secret'); expect(new URL(writtenUrl).searchParams.get('access_token')).toBe('token-secret');
    expect(writtenUrl).not.toContain(MCP_SECRET_PLACEHOLDER);
  });
  it('only restores placeholders for previous parameters with the same key and rejects newly created placeholders', () => {
    const { manager } = setup();
    expect(() => manager.save({ name: 'new', transport: 'stdio', command: 'server', args: ['--token', MCP_SECRET_PLACEHOLDER], enabledTools: [] })).toThrow('同名');
    expect(() => manager.save({ name: 'new', transport: 'http', url: 'https://example.com/mcp?api_key=' + MCP_SECRET_PLACEHOLDER, enabledTools: [] })).toThrow('原参数');
    const saved = manager.save({ name: 'old', transport: 'stdio', command: 'server', args: ['--token', 'secret-old', '--password=second-secret'], enabledTools: [] });
    expect(() => manager.save({ ...saved, args: ['--api-key', MCP_SECRET_PLACEHOLDER] })).toThrow('同名');
    expect(() => manager.save({ ...saved, args: ['--token', 'prefix' + MCP_SECRET_PLACEHOLDER] })).toThrow('同名');
    manager.save({ ...saved, args: ['--password=' + MCP_SECRET_PLACEHOLDER, '--token', MCP_SECRET_PLACEHOLDER] });
    expect(manager.list()[0].args).toEqual(['--password=' + MCP_SECRET_PLACEHOLDER, '--token', MCP_SECRET_PLACEHOLDER]);
    expect(() => manager.save({ ...saved, env: { TOKEN: MCP_SECRET_PLACEHOLDER } })).toThrow('Env/Headers');
    const urlSaved = manager.save({ name: 'url-old', transport: 'http', url: 'https://example.com/mcp?token=stored-secret', enabledTools: [] });
    expect(() => manager.save({ ...urlSaved, url: 'https://other.example.com/mcp?token=' + MCP_SECRET_PLACEHOLDER })).toThrow('同一地址');
    expect(() => manager.save({ ...urlSaved, url: 'https://example.com/mcp?password=' + MCP_SECRET_PLACEHOLDER })).toThrow('对应');
    expect(() => manager.save({ name: 'encoded', transport: 'http', url: 'https://example.com/mcp?token=' + MCP_SECRET_PLACEHOLDER.replaceAll('_', '%5F'), enabledTools: [] })).toThrow('原参数');
  });
  it('allows deliberate credential replacement and rejects inline command credentials without mistaking Windows spaced paths', () => {
    const { root, manager } = setup();
    const saved = manager.save({ name: 'args', transport: 'stdio', command: 'C:\\Program Files\\server.exe', args: ['--token', 'old-secret'], enabledTools: ['copilot'] });
    manager.save({ ...saved, args: ['--token', 'new-secret'] }); manager.apply('copilot');
    expect(JSON.parse(readFileSync(join(root, '.copilot', 'mcp-config.json'), 'utf8')).mcpServers.args.args).toEqual(['--token', 'new-secret']);
    for (const command of ['server --token secret', 'server --api-key=secret', 'API_KEY=secret server']) expect(() => manager.save({ name: 'inline', transport: 'stdio', command, enabledTools: [] })).toThrow('内联凭据');
  });
  it('imports only safe command layouts and redacts imported argument/query credentials', () => {
    const { root, manager } = setup(); mkdirSync(join(root, '.copilot')); const filename = join(root, '.copilot', 'mcp-config.json');
    writeFileSync(filename, JSON.stringify({ mcpServers: { unsafe: { type: 'local', command: 'node --token inline-secret', args: [] }, safe: { type: 'local', command: 'node', args: ['--token', 'imported-secret'] }, remote: { type: 'http', url: 'https://example.com/mcp?x-api-key=query-imported-secret' } } }));
    const result = manager.importFromTool('copilot'); expect(result.imported).toBe(2); expect(result.skipped).toBe(1);
    const rendered = JSON.stringify(result) + JSON.stringify(manager.list()) + JSON.stringify(manager.preview('copilot'));
    for (const secret of ['inline-secret', 'imported-secret', 'query-imported-secret']) expect(rendered).not.toContain(secret);
    const safe = manager.list().find(server => server.name === 'safe')!; manager.save({ ...safe }); manager.apply('copilot');
    expect(JSON.parse(readFileSync(filename, 'utf8')).mcpServers.safe.args[1]).toBe('imported-secret'); expect(JSON.parse(readFileSync(filename, 'utf8')).mcpServers.unsafe.command).toContain('inline-secret');
  });
  it('uses explicit CODEX_HOME paths and never changes the default home configuration', () => {
    const { root, states } = setup(); const alternate = join(root, 'custom-codex'); mkdirSync(alternate);
    const defaultDirectory = join(root, '.codex'); mkdirSync(defaultDirectory); writeFileSync(join(defaultDirectory, 'config.toml'), 'model="untouched"');
    const manager = new McpManager({ getManagedState: <T>(key: string, fallback: T) => (states.get(key) ?? fallback) as T, setManagedState: (key, value) => { states.set(key, JSON.parse(JSON.stringify(value))); } }, { homeDir: root, codexHome: alternate, appDataDir: root, backupDir: join(root, 'backups') });
    local(manager); expect(manager.preview('codex').filename).toBe(join(alternate, 'config.toml')); manager.apply('codex');
    expect((parseToml(readFileSync(join(alternate, 'config.toml'), 'utf8')) as any).mcp_servers['test-server'].command).toBe('npx'); expect(readFileSync(join(defaultDirectory, 'config.toml'), 'utf8')).toBe('model="untouched"');
  });
});
