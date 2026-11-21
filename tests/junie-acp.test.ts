import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildJunieAcpEntry, JUNIE_ACP_NAME, junieAcpTarget, mergeJunieAcp, readJunieAcpEntry, resolveJunieCommand } from '../src/main/junie-acp';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'modeldock-junie-acp-')); roots.push(root); return root; }
function file(path: string, content = '') { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); chmodSync(path, 0o700); return path; }
function ideJunie(local: string, ide = 'IntelliJIdea2026.3', version = '4100.11.0', marker = './junie/junie.exe') {
  const install = join(local, 'JetBrains', ide, 'acp-agents', 'junie', version);
  file(join(install, '.installed'), marker);
  return file(join(install, 'junie', 'junie.exe'));
}

describe('Junie IDE ACP integration helpers', () => {
  it('merges and removes only its named agent while retaining other agents and MCP preferences', () => {
    const home = fixture(), command = file(join(home, 'junie.exe'));
    const entry = buildJunieAcpEntry('custom:modeldock', join(home, 'Junie home'), { command, args: [], env: { KEEP: 'value' } });
    expect(entry).toEqual({ command, args: ['--acp', 'true', '--model', 'custom:modeldock'], env: { KEEP: 'value', JUNIE_HOME: join(home, 'Junie home') } });
    const unrelated = { default_mcp_settings: { use_idea_mcp: false, use_custom_mcp: true }, agent_servers: { Existing: { command: '/keep/agent', args: ['acp'] } }, future: { enabled: true } };
    const original = JSON.stringify(unrelated);
    const merged = mergeJunieAcp(original, entry)!;
    expect(JSON.parse(merged)).toEqual({ ...unrelated, agent_servers: { ...unrelated.agent_servers, [JUNIE_ACP_NAME]: entry } });
    expect(readJunieAcpEntry(merged)).toEqual({ present: true, value: entry });
    expect(mergeJunieAcp(merged, entry)).toBe(merged);
    expect(JSON.parse(mergeJunieAcp(merged, null)!)).toEqual(unrelated);
    expect(mergeJunieAcp(original, null)).toBe(original);
    expect(mergeJunieAcp(null, null)).toBeNull();
    expect(junieAcpTarget(home)).toBe(join(home, '.jetbrains', 'acp.json'));
  });

  it('preserves unknown existing agent shapes for caller-owned conflict detection and rejects malformed documents', () => {
    expect(readJunieAcpEntry(JSON.stringify({ agent_servers: { [JUNIE_ACP_NAME]: { foreign: true } } }))).toEqual({ present: true, value: { foreign: true } });
    expect(readJunieAcpEntry(null)).toEqual({ present: false });
    for (const value of ['{', '[]', 'null', '{"agent_servers":[]}', '{"agent_servers":null}']) {
      expect(() => mergeJunieAcp(value, null)).toThrow(/acp.json/);
      expect(() => readJunieAcpEntry(value)).toThrow(/acp.json/);
    }
  });

  it('resolves the managed Windows native binary instead of interpreting a batch launcher', () => {
    const home = fixture(), data = join(home, '.local', 'share', 'junie');
    file(join(home, '.local', 'bin', 'junie.bat'), '@echo off\n');
    file(join(data, 'current'), '3893.6\n');
    const exe = file(join(data, 'versions', '3893.6', 'junie', 'junie.exe'));
    expect(resolveJunieCommand(home, { platform: 'win32', env: { Path: '' } })).toEqual({ command: exe, args: [] });
    const entry = buildJunieAcpEntry('custom:modeldock', join(home, '中文 & 100% Junie'), { command: exe, args: [] });
    expect(entry.env.JUNIE_HOME).toBe(join(home, '中文 & 100% Junie'));
    expect(entry.command).toBe(exe);
    expect(entry.args).not.toContain('/c');
    writeFileSync(join(data, 'current'), '../../foreign');
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })).toBeUndefined();
    expect(readFileSync(join(home, '.local', 'bin', 'junie.bat'), 'utf8')).toBe('@echo off\n');
  });

  it('honors explicit managed data and native PATH installs and refuses unavailable launchers', () => {
    const home = fixture(), nativeBin = join(home, 'native & path');
    const native = file(join(nativeBin, 'junie.exe'));
    expect(resolveJunieCommand(home, { platform: 'win32', env: { PATH: nativeBin } })).toEqual({ command: native, args: [] });
    const data = join(home, 'custom managed data');
    file(join(data, 'current'), 'release-123');
    const managed = file(join(data, 'versions', 'release-123', 'junie', 'junie.exe'));
    expect(resolveJunieCommand(home, { platform: 'win32', env: { JUNIE_DATA_DIR: data } })?.command).toBe(managed);
    expect(resolveJunieCommand(home, { platform: 'win32', env: { JUNIE_DATA_DIR: 'relative' } })).toBeUndefined();
    const linux = file(join(home, '.local', 'bin', 'junie'), '#!/bin/sh\n');
    expect(resolveJunieCommand(home, { platform: 'linux', env: {} })?.command).toBe(linux);
    expect(() => buildJunieAcpEntry('custom:../../other', home, { command: native, args: [] })).toThrow(/无效/);
  });

  it('resolves the verified IDE ACP native package layout and chooses the newest numeric Junie version across IDEs', () => {
    const home = fixture(), local = join(home, 'AppData', 'Local');
    ideJunie(local, 'WebStorm2026.2', '2045.46.0');
    ideJunie(local, 'IntelliJIdea2026.3', '4100.8.0');
    ideJunie(local, 'IntelliJIdea2026.3', '4020.10.0');
    const current = ideJunie(local);
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })).toEqual({ command: current, args: [] });
    ideJunie(local, 'WebStorm2026.3', '4100.11.0');
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })?.command).toBe(current);
    const newer = ideJunie(local, 'Rider2026.2', '4100.100.0');
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })?.command).toBe(newer);
    const entry = buildJunieAcpEntry('custom:modeldock', join(home, 'Junie home'), { command: current, args: [] });
    expect(entry.args).toEqual(['--acp', 'true', '--model', 'custom:modeldock']);
    expect(entry.command.endsWith('junie.exe')).toBe(true);
  });

  it('keeps native and standalone installs ahead of IDE fallback without bypassing explicit data locations', () => {
    const home = fixture(), local = join(home, 'AppData', 'Local');
    const ide = ideJunie(local), data = join(home, '.local', 'share', 'junie');
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })?.command).toBe(ide);
    for (const variable of ['JUNIE_DATA_DIR', 'JUNIE_DATA']) {
      for (const value of ['relative', join(home, 'missing')]) {
        expect(resolveJunieCommand(home, { platform: 'win32', env: { [variable]: value } })).toBeUndefined();
      }
    }
    file(join(data, 'current'), '3893.6');
    const standalone = file(join(data, 'versions', '3893.6', 'junie', 'junie.exe'));
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })?.command).toBe(standalone);
    const native = file(join(home, 'native', 'junie.exe'));
    expect(resolveJunieCommand(home, { platform: 'win32', env: { PATH: dirname(native) } })?.command).toBe(native);
    writeFileSync(join(data, 'current'), '../../foreign');
    expect(resolveJunieCommand(home, { platform: 'win32', env: { JUNIE_DATA_DIR: data } })).toBeUndefined();
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })).toBeUndefined();
  });

  it('isolates custom homes from inherited LocalAppData while honoring an explicit relocated root', () => {
    const home = fixture(), foreign = fixture(), local = join(home, 'AppData', 'Local');
    const foreignExe = ideJunie(foreign), ownExe = ideJunie(local);
    vi.stubEnv('LOCALAPPDATA', foreign);
    vi.stubEnv('PATH', '');
    vi.stubEnv('Path', '');
    vi.stubEnv('JUNIE_DATA_DIR', undefined);
    vi.stubEnv('JUNIE_DATA', undefined);
    expect(resolveJunieCommand(home, { platform: 'win32' })?.command).toBe(ownExe);
    expect(resolveJunieCommand(home, { platform: 'win32', env: { LocalAppData: foreign } })?.command).toBe(foreignExe);
    expect(resolveJunieCommand(home, { platform: 'win32', env: { LOCALAPPDATA: 'relative' } })).toBeUndefined();
    expect(resolveJunieCommand(home, { platform: 'linux', env: { LOCALAPPDATA: foreign } })).toBeUndefined();
  });

  it('ignores incomplete, malformed and unrelated IDE packages', () => {
    const home = fixture(), local = join(home, 'AppData', 'Local');
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })).toBeUndefined();
    ideJunie(local, 'Unrelated2026.3');
    ideJunie(local, 'IntelliJIdea2026.3', 'release-4100');
    ideJunie(local, 'IntelliJIdea2026.3', '04100.11.0');
    ideJunie(local, 'IntelliJIdea2026.3', '9999999999.1.0');
    ideJunie(local, 'IntelliJIdea2026.3', '4100.12.0', '../../foreign.exe');
    ideJunie(local, 'IntelliJIdea2026.3', '4100.13.0', 'x'.repeat(257));
    const noMarker = ideJunie(local, 'IntelliJIdea2026.3', '4100.14.0');
    rmSync(join(dirname(dirname(noMarker)), '.installed'));
    const noExe = ideJunie(local, 'IntelliJIdea2026.3', '4100.15.0');
    rmSync(noExe);
    file(join(dirname(dirname(noExe)), 'junie.bat'), '@echo off\n');
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })).toBeUndefined();
    const valid = ideJunie(local);
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })?.command).toBe(valid);
  });

  it('does not traverse directory links outside the IDE ACP installation tree', () => {
    const home = fixture(), local = join(home, 'AppData', 'Local'), external = fixture();
    const foreignExe = ideJunie(external), root = join(local, 'JetBrains');
    mkdirSync(root, { recursive: true });
    symlinkSync(join(external, 'JetBrains', 'IntelliJIdea2026.3'), join(root, 'IntelliJIdea2026.3'), 'junction');
    const webstorm = join(root, 'WebStorm2026.3');
    mkdirSync(webstorm);
    symlinkSync(join(external, 'JetBrains', 'IntelliJIdea2026.3', 'acp-agents'), join(webstorm, 'acp-agents'), 'junction');
    const versions = join(root, 'Rider2026.2', 'acp-agents', 'junie');
    mkdirSync(versions, { recursive: true });
    symlinkSync(dirname(dirname(foreignExe)), join(versions, '4100.11.0'), 'junction');
    const pycharm = join(root, 'PyCharm2026.3', 'acp-agents', 'junie', '4100.11.0');
    file(join(pycharm, '.installed'), './junie/junie.exe');
    symlinkSync(dirname(foreignExe), join(pycharm, 'junie'), 'junction');
    expect(resolveJunieCommand(home, { platform: 'win32', env: {} })).toBeUndefined();
  });
});
