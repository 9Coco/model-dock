import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildJunieAcpEntry, JUNIE_ACP_NAME, junieAcpTarget, mergeJunieAcp, readJunieAcpEntry, resolveJunieCommand } from '../src/main/junie-acp';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'modeldock-junie-acp-')); roots.push(root); return root; }
function file(path: string, content = '') { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); chmodSync(path, 0o700); return path; }

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
});
