import { describe, expect, it, vi } from 'vitest';
import { captureCopilotCredentials, restoreCopilotCredentials, CopilotCredentialError, type CopilotCredentialBackup, type CopilotCredentialEntry } from '../src/main/copilot-credentials';

const first = 'b6c4f9bf-9df2-43c5-8964-841f83b4fc6a', second = 'b6c4f9bf-9df2-43c5-8964-841f83b4fc6b';
const entry = (kind: CopilotCredentialEntry['kind'] = 'api_key'): CopilotCredentialEntry => ({ kind, blobBase64: Buffer.from([0, 1, 255, 2, 42]).toString('base64'), flags: 0, persist: 3, userName: `byok:${first}:apiKey`, comment: 'Original metadata', targetAlias: null, attributes: [{ keyword: 'native-attribute', flags: 0, valueBase64: Buffer.from([9, 0, 255]).toString('base64') }] });
const snapshot = (): CopilotCredentialBackup => ({ version: 1, providers: [{ providerId: first, entries: [entry(), entry('bearer_token')] }, { providerId: second, entries: [] }] });

describe('Copilot exact-domain opaque credential backup', () => {
  it('requests only verified provider UUIDs and keeps opaque bytes/metadata intact without decoding keys', async () => {
    const input = snapshot(), run = vi.fn(async (operation, payload) => { expect(operation).toBe('capture'); expect(payload).toEqual([first, second]); return { ok: true, backup: input }; });
    const result = await captureCopilotCredentials([first, second], { platform: 'win32', run });
    expect(result).toEqual(input); expect(result).not.toBe(input); result.providers[0].entries[0].comment = 'Modified private copy'; expect(input.providers[0].entries[0].comment).toBe('Original metadata'); expect(run).toHaveBeenCalledOnce();
    expect(result.providers[1].entries).toEqual([]); expect(result.providers[0].entries[0]).not.toHaveProperty('apiKey'); expect(result.providers[0].entries[0]).not.toHaveProperty('targetName');
  });

  it('restores the complete private backup, including previous absence, without allowing arbitrary target names', async () => {
    const value = snapshot(), run = vi.fn(async (operation, payload) => { expect(operation).toBe('restore'); expect(payload).toEqual(value); expect(payload).not.toBe(value); return { ok: true }; });
    await restoreCopilotCredentials(value, { platform: 'win32', run }); expect(run).toHaveBeenCalledOnce();
    const altered = snapshot(); (altered.providers[0].entries[0] as any).targetName = 'OTHER_APP_PRIVATE_TARGET';
    await expect(restoreCopilotCredentials(altered, { platform: 'win32', run })).rejects.toMatchObject({ category: 'configuration' }); expect(run).toHaveBeenCalledOnce();
  });

  it.each(['linux', 'darwin', 'unsupported'])('refuses an unverified %s keyring interface before I/O', async platform => {
    const run = vi.fn(); await expect(captureCopilotCredentials([first], { platform, run })).rejects.toMatchObject({ category: 'unsupported-platform' }); await expect(restoreCopilotCredentials(snapshot(), { platform, run })).rejects.toMatchObject({ category: 'unsupported-platform' }); expect(run).not.toHaveBeenCalled();
  });

  it.each([['arbitrary-account-name'], ['../credentials'], ['b6c4f9bf-9df2-43c5-8964-841f83b4fc6a:apiKey.other-app'], [first, first], [42]].map(ids => ({ ids })))('rejects targets outside the exact UUID namespace before any system call', async ({ ids }) => {
    const run = vi.fn(); await expect(captureCopilotCredentials(ids as string[], { platform: 'win32', run })).rejects.toMatchObject({ category: 'configuration' }); expect(run).not.toHaveBeenCalled();
  });

  it('rejects a capture response for a different provider instead of backing up/deleting the requested one', async () => {
    const run = vi.fn(async () => ({ ok: true, backup: snapshot() }));
    await expect(captureCopilotCredentials([first], { platform: 'win32', run })).rejects.toMatchObject({ category: 'protocol' });
  });

  it('never converts a native read failure into a missing credential backup or exposes native diagnostics', async () => {
    for (const run of [async () => ({ ok: false, error: 'PRIVATE_BLOB PRIVATE_ACCOUNT_TARGET' }), async () => { throw new Error('PRIVATE_BLOB PRIVATE_ACCOUNT_TARGET'); }]) {
      const error = await captureCopilotCredentials([first], { platform: 'win32', run }).catch(e => e);
      expect(error).toBeInstanceOf(CopilotCredentialError); expect(error).toMatchObject({ category: 'read' }); expect(String(error)).not.toMatch(/PRIVATE_|ACCOUNT_TARGET/);
    }
  });

  it('rejects partial/duplicate roles, malformed binary payloads and unbounded attributes before credential writes', async () => {
    const values: CopilotCredentialBackup[] = [];
    let value = snapshot(); value.providers[0].entries.push(entry()); values.push(value);
    value = snapshot(); value.providers[0].entries[1] = entry(); values.push(value);
    value = snapshot(); value.providers[0].entries[0].blobBase64 = 'PRIVATE_MALFORMED_BLOB'; values.push(value);
    value = snapshot(); value.providers[0].entries[0].blobBase64 = Buffer.alloc(16385).toString('base64'); values.push(value);
    value = snapshot(); value.providers[0].entries[0].persist = 99; values.push(value);
    value = snapshot(); value.providers[0].entries[0].flags = -1; values.push(value);
    value = snapshot(); value.providers[0].entries[0].comment = 'INVALID\0COMMENT'; values.push(value);
    value = snapshot(); value.providers[0].entries[0].attributes[0].valueBase64 = Buffer.alloc(8193).toString('base64'); values.push(value);
    value = snapshot(); value.providers[0].entries[0].attributes.push(value.providers[0].entries[0].attributes[0]); values.push(value);
    value = snapshot(); (value.providers[0].entries[0] as any).kind = 'github_access_token'; values.push(value);
    const run = vi.fn();
    for (const invalid of values) await expect(restoreCopilotCredentials(invalid, { platform: 'win32', run })).rejects.toMatchObject({ category: 'configuration' }); expect(run).not.toHaveBeenCalled();
  });

  it('returns a controlled write failure without forwarding any credential or error body', async () => {
    const error = await restoreCopilotCredentials(snapshot(), { platform: 'win32', run: async () => ({ ok: false, raw: snapshot() }) }).catch(e => e);
    expect(error).toMatchObject({ category: 'write' }); expect(String(error)).not.toContain(snapshot().providers[0].entries[0].blobBase64);
  });
});
