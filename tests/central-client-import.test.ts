import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CentralClientImporter, CentralClientImportError, type CentralCommandResult, type CentralCommandRunner } from '../src/main/central-client-import';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const quota = { managed: false, tariffQuota: { current: '1.00', maximum: '20', available: '19.00' }, email: 'private@example.invalid', licenseName: 'Private license' };
const success = (stdout: string): CentralCommandResult => ({ exitCode: 0, stdout, stderr: '' });
function fixture(status = '⣿ Auth logged in (AI Pro)\n⣿ Proxy stopped', allowance: unknown = quota) {
  const run = vi.fn<CentralCommandRunner>(async (_exe, args) => success(args[0] === 'status' ? status : JSON.stringify(allowance)));
  const importer = new CentralClientImporter({ resolveExecutable: async () => join(tmpdir(), 'central'), run, now: () => Date.UTC(2026, 10, 5) });
  return { importer, run };
}

describe('explicit import of the current Central CLI authorization', () => {
  it.each(['⣿ Auth logged in (AI Pro)\n⣿ Proxy stopped', '\u001b[38;2;46;125;50m⣿\u001b[m \u001b[1mAuth\u001b[m connected to private@example.invalid (AI Pro)\nProxy running'])('checks the CLI login and a real allowance command without exposing identity or quota output', async status => {
    const { importer, run } = fixture(status);
    expect(await importer.verifyCurrent()).toEqual({ client: 'central-cli', authorization: 'verified', verifiedAt: '2026-11-05T00:00:00.000Z' });
    expect(run.mock.calls.map(call => call[1])).toEqual([['status'], ['limit', '--json']]);
    expect(JSON.stringify(await importer.verifyCurrent())).not.toMatch(/private@example|Private license|tariffQuota/);
  });

  it('accepts the separate workspace allowance format and zero balances without claiming inference succeeded', async () => {
    const { importer } = fixture(undefined, { managed: true, usedDollars: '0.00', maxDollars: '0' });
    expect(await importer.verifyCurrent()).toMatchObject({ authorization: 'verified' });
  });

  it('does not treat an installed or configured client as a logged-in account', async () => {
    const { importer, run } = fixture('⠶ Auth not connected\n⣿ Proxy running\nPi configured');
    await expect(importer.verifyCurrent()).rejects.toMatchObject({ code: 'not-logged-in' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects stale or ambiguous login state instead of opening login or switching licenses', async () => {
    for (const status of ['Auth logged in (AI Pro)\nAuthentication can\'t be refreshed — run central login', 'Auth not logged in', 'Proxy running\nPi installed', 'Auth logged in\nAuth not connected']) {
      const { importer, run } = fixture(status);
      await expect(importer.verifyCurrent()).rejects.toBeInstanceOf(CentralClientImportError);
      expect(run.mock.calls.map(call => call[1])).toEqual([['status']]);
    }
  });

  it('rejects missing executables without running account commands', async () => {
    const run = vi.fn<CentralCommandRunner>();
    const importer = new CentralClientImporter({ resolveExecutable: async () => undefined, run });
    await expect(importer.verifyCurrent()).rejects.toMatchObject({ code: 'not-installed' });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { managed: false }, { managed: false, error: 'PRIVATE_ERROR', tariffQuota: quota.tariffQuota }, { managed: false, tariffQuota: { current: 'NaN', maximum: '20', available: '19' } }, { managed: false, usedDollars: '-1', maxDollars: '20' }])('requires a valid live allowance result, rejecting %j', async allowance => {
    const { importer } = fixture(undefined, allowance);
    await expect(importer.verifyCurrent()).rejects.toMatchObject({ code: 'unsupported-response' });
  });

  it('sanitizes command failures, timeouts, invalid JSON and oversized output', async () => {
    for (const problem of [new Error('PRIVATE_TOKEN user-path'), { exitCode: 1, stdout: 'PRIVATE_TOKEN', stderr: 'private/path' }, success('x'.repeat(70 * 1024)), success('not-json PRIVATE_TOKEN')]) {
      const run = vi.fn<CentralCommandRunner>(async (_exe, args) => {
        if (args[0] === 'status') return success('Auth logged in');
        if (problem instanceof Error) throw problem;
        return problem;
      });
      const importer = new CentralClientImporter({ resolveExecutable: async () => join(tmpdir(), 'central'), run });
      const error = await importer.verifyCurrent().then(() => undefined, error => error);
      expect(error).toBeInstanceOf(CentralClientImportError);
      expect(String(error)).not.toMatch(/PRIVATE_TOKEN|private\/path|user-path/);
      expect(run.mock.calls.every(call => ['status', 'limit'].includes(call[1][0]))).toBe(true);
    }
  });

  it.skipIf(process.platform === 'win32')('runs fixed commands through an installed CLI with an isolated environment and preserves all native files', async () => {
    const home = await mkdtemp(join(tmpdir(), 'central-client-import-')); roots.push(home);
    const bin = join(home, '.local', 'bin'); await mkdir(bin, { recursive: true });
    const credential = join(home, '.jetbrains-central', 'tokens.enc'), settings = join(home, '.pi', 'agent', 'settings.json');
    await mkdir(join(home, '.jetbrains-central')); await mkdir(join(home, '.pi', 'agent'), { recursive: true });
    await writeFile(credential, 'SYNTHETIC_NATIVE_CREDENTIAL_UNTOUCHED', { mode: 0o600 });
    await writeFile(settings, '{"native":"keep"}', { mode: 0o600 });
    const exe = join(bin, 'central');
    await writeFile(exe, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);fs.appendFileSync(path.join(process.env.HOME,'observed.jsonl'),JSON.stringify({args,home:process.env.HOME,cwd:process.cwd(),vendor:!!process.env.OPENAI_API_KEY||!!process.env.ANTHROPIC_API_KEY,shellHook:!!process.env.BASH_ENV||!!process.env.NODE_OPTIONS,override:!!process.env.WIRE_PROXY_PORT})+'\\n');if(args.length===1&&args[0]==='status'){console.log('Auth connected to AI Pro');}else if(JSON.stringify(args)===JSON.stringify(['limit','--json'])){console.log(JSON.stringify(${JSON.stringify(quota)}));}else{process.stderr.write('PRIVATE_INVALID_COMMAND');process.exit(90);}`);
    await chmod(exe, 0o700);
    vi.stubEnv('PATH', bin); vi.stubEnv('OPENAI_API_KEY', 'SYNTHETIC_VENDOR_TOKEN'); vi.stubEnv('ANTHROPIC_API_KEY', 'SYNTHETIC_VENDOR_TOKEN');
    vi.stubEnv('NODE_OPTIONS', '--require private-hook'); vi.stubEnv('BASH_ENV', 'private-hook'); vi.stubEnv('WIRE_PROXY_PORT', '9999');
    const importer = new CentralClientImporter({ homeDir: home });
    expect(await importer.verifyCurrent()).toMatchObject({ client: 'central-cli', authorization: 'verified' });
    const observations = (await readFile(join(home, 'observed.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(observations.map(item => item.args)).toEqual([['status'], ['limit', '--json']]);
    expect(observations.every(item => item.home === home && item.cwd === home && !item.vendor && !item.shellHook && !item.override)).toBe(true);
    expect(await readFile(credential, 'utf8')).toBe('SYNTHETIC_NATIVE_CREDENTIAL_UNTOUCHED');
    expect(await readFile(settings, 'utf8')).toBe('{"native":"keep"}');
  });
});
