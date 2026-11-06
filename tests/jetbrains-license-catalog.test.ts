import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJetBrainsIdeLicenseCatalog, JetBrainsLicenseCatalogError } from '../src/main/jetbrains-license-catalog';
import * as codec from '../src/main/jetbrains-license-codec';
import { JetBrainsIdeApi } from '../src/main/jetbrains-ide-api';

const NOW = Date.UTC(2026, 10, 6), owner = 'synthetic-owner', sourceLicenseId = 'SYNTHETIC_SOURCE_LICENSE';
const jwt = (payload: object) => [Buffer.from('{"alg":"RS256"}').toString('base64url'), Buffer.from(JSON.stringify(payload)).toString('base64url'), Buffer.from('SYNTHETIC_SIGNATURE').toString('base64url')].join('.');
const idToken = jwt({ user_id: owner }), token = jwt({ exp: NOW / 1000 + 3600 });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
// Exact outer shape independently emitted and round-tripped by the installed
// official x serializer (legacy-public-wire.txt), not a guessed JSON envelope.
const xml = (salt: string, data: string[] = [], code = 'OK') => `<ObtainLicenseResponse><action>NONE</action><assets>${data.map(value => `<EncodedAsset><data>${value}</data></EncodedAsset>`).join('')}</assets><responseCode>${code}</responseCode><salt>${salt}</salt><validationDeadlinePeriod>-1</validationDeadlinePeriod><validationPeriod>0</validationPeriod></ObtainLicenseResponse>`;
const reply = (value: string) => new Response(value, { headers: { 'Content-Type': 'application/xml;charset=UTF-8' } });
const input = (fetch: typeof globalThis.fetch, signal = new AbortController().signal) => ({ fetch, accountId: owner, version: '0.3.84', now: () => NOW, signal });
afterEach(() => vi.restoreAllMocks());

describe('JetBrains official read-only product license catalog', () => {
  it('uses the proven protocol version and date units with truthful caller metadata, omitting all credential headers', async () => {
    const products: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const parsed = new URL(String(url)), code = parsed.searchParams.get('productCode')!; products.push(code);
      expect(parsed.origin + parsed.pathname).toBe('https://account.jetbrains.com/lservice/rpc/obtainLicense.action');
      expect(Object.fromEntries(parsed.searchParams)).toMatchObject({ userId: owner, productFamilyId: code, expiredLicenseDays: '0', clientVersion: '22', version: '2026200', buildDate: '20260716', hostName: 'ModelDock', userName: 'ModelDock', ideProductCode: 'ModelDock', salt: String(NOW) });
      expect(parsed.searchParams.has('idToken')).toBe(false); expect(parsed.searchParams.has('accessToken')).toBe(false);
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
      const headers = new Headers(init?.headers); expect(headers.get('User-Agent')).toBe('ModelDock/0.3.84');
      for (const name of ['Authorization', 'Grazie-Authenticate-JWT', 'Cookie']) expect(headers.has(name)).toBe(false);
      return reply(xml(parsed.searchParams.get('salt')!));
    });
    expect(await readJetBrainsIdeLicenseCatalog(input(fetch))).toEqual([]);
    expect(products).toEqual(['AIPU', 'AIP', 'AIPEAP', 'AIF']);
  });
  it('keeps different Free license IDs separate and derives names from official product codes, not credit amounts', async () => {
    vi.spyOn(codec, 'decodeLicenseAsset').mockImplementation(value => ({ id: value, productCode: value.startsWith('FREE') ? 'AIF' : 'AIPU', kind: 'STANDARD', licenseeType: 'INDIVIDUAL', licensePack: 'NONE', expiresOn: '2027-08-15' }));
    const fetch = vi.fn<typeof globalThis.fetch>(async url => { const u = new URL(String(url)), code = u.searchParams.get('productCode'); return reply(xml(String(NOW), code === 'AIF' ? ['FREE1', 'FREE2', 'FREE3'] : code === 'AIPU' ? ['ULTIMATE1'] : [])); });
    const rows = await readJetBrainsIdeLicenseCatalog(input(fetch));
    expect(rows.map(row => [row.id, row.plan])).toEqual([['ULTIMATE1', 'JetBrains AI Ultimate'], ['FREE1', 'JetBrains AI Free'], ['FREE2', 'JetBrains AI Free'], ['FREE3', 'JetBrains AI Free']]);
    expect(rows.every(row => row.expiresAt === '2027-08-15')).toBe(true);
  });
  it('matches the official priority when one license appears under several included products', async () => {
    vi.spyOn(codec, 'decodeLicenseAsset').mockImplementation(value => { const [id, productCode] = value.split(':'); return { id, productCode, kind: 'STANDARD', licenseeType: 'INDIVIDUAL', licensePack: 'NONE', expiresOn: '2027-03-14' }; });
    const fetch = vi.fn<typeof globalThis.fetch>(async url => { const code = new URL(String(url)).searchParams.get('productCode')!; return reply(xml(String(NOW), code === 'AIPEAP' ? [] : ['SAME:' + code])); });
    expect(await readJetBrainsIdeLicenseCatalog(input(fetch))).toEqual([{ id: 'SAME', productCode: 'AIPU', plan: 'JetBrains AI Ultimate', kind: 'STANDARD', expiresAt: '2027-03-14' }]);
  });
  it('rejects inconsistent same-license receipts instead of merging expiration dates', async () => {
    vi.spyOn(codec, 'decodeLicenseAsset').mockImplementation(code => ({ id: 'SAME', productCode: code, kind: 'STANDARD', licenseeType: 'INDIVIDUAL', licensePack: 'NONE', expiresOn: code === 'AIPU' ? '2027-03-14' : '2027-08-15' }));
    const fetch = vi.fn<typeof globalThis.fetch>(async url => reply(xml(String(NOW), [new URL(String(url)).searchParams.get('productCode')!])));
    await expect(readJetBrainsIdeLicenseCatalog(input(fetch))).rejects.toMatchObject({ code: 'response' });
  });
  it.each(['ERROR', 'SERVER_INTERNAL_ERROR'])('rejects official %s responses without exposing messages or accepting a partial catalog', async code => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => reply(xml(String(NOW), [], code).replace('</ObtainLicenseResponse>', '<message>PRIVATE_UPSTREAM_BODY_TOKEN</message></ObtainLicenseResponse>')));
    const error = await readJetBrainsIdeLicenseCatalog(input(fetch)).catch(value => value);
    expect(error).toBeInstanceOf(JetBrainsLicenseCatalogError); expect(error.code).toBe('response'); expect(String(error)).not.toContain('PRIVATE_');
  });
  it.each([xml('other-salt'), xml(String(NOW)).replace('<action>NONE', '<action>ACTIVATE'), xml(String(NOW)).replace('</assets>', '<Unknown/></assets>'), '<!DOCTYPE x SYSTEM "https://private.test"><ObtainLicenseResponse/>'])('rejects mismatched or unsafe native envelopes', async value => {
    await expect(readJetBrainsIdeLicenseCatalog(input(vi.fn(async () => reply(value))))).rejects.toMatchObject({ code: 'response' });
  });
  it('rejects redirects without sending tokens to a new origin', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { const response = reply(xml(String(NOW))); Object.defineProperty(response, 'redirected', { value: true }); return response; });
    await expect(readJetBrainsIdeLicenseCatalog(input(fetch))).rejects.toMatchObject({ code: 'network' });
    expect(fetch.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });
});

describe('JetBrains account license directory ownership and lifecycle', () => {
  function transport() {
    const seen: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const u = new URL(String(url)); seen.push(u.pathname);
      if (u.pathname.includes('/provide-access/')) { expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + idToken); return json({ token }); }
      if (u.pathname.endsWith('/verify/v3')) return json({ expires: NOW + 3600_000 });
      return reply(xml(u.searchParams.get('salt')!));
    });
    return { fetch, seen };
  }
  it('verifies the unchanged selected source before owner-keyed catalog access and shares an accurately dated cache', async () => {
    const { fetch, seen } = transport(), api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    const auth = { idToken, accountId: owner, sourceLicenseId };
    expect(await Promise.all([api.licenses(auth), api.licenses(auth)])).toEqual([[], []]);
    expect(seen.slice(0, 2)).toEqual(['/auth/jetbrains-jwt/provide-access/license/v2', '/user/v5/auth/jwt/verify/v3']);
    expect(fetch).toHaveBeenCalledTimes(6);
    await api.licenses(auth); expect(fetch).toHaveBeenCalledTimes(6);
  });
  it('rejects wrong owner assertions and missing selected licenses before any network request', async () => {
    const { fetch } = transport(), api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    await expect(api.licenses({ idToken, accountId: 'another-owner', sourceLicenseId })).rejects.toMatchObject({ code: 'credentials' });
    await expect(api.licenses({ idToken, accountId: owner })).rejects.toMatchObject({ code: 'credentials' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not use an inference-audience JCP token to query an unverified legacy owner', async () => {
    const { fetch } = transport(), api = new JetBrainsIdeApi({ fetch, now: () => NOW });
    await expect(api.licenses({ tokenType: 'jcp-global-access-token', accessToken: 'SYNTHETIC_JCP_INFERENCE_TOKEN', accountId: 'unverified-owner', sourceLicenseId })).rejects.toMatchObject({ code: 'license-source' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not request catalog data after a failed source authorization', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ error: 'PRIVATE_SOURCE_TOKEN' }, 401));
    await expect(new JetBrainsIdeApi({ fetch, now: () => NOW }).licenses({ idToken, accountId: owner, sourceLicenseId })).rejects.toMatchObject({ code: 'authorization' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels one waiter independently without aborting another account row reading the same directory', async () => {
    let resolveProof!: (value: Response) => void;
    const { fetch: rest } = transport();
    const fetch = vi.fn<typeof globalThis.fetch>((url, init) => String(url).includes('/provide-access/') ? new Promise(resolve => { resolveProof = resolve; }) : rest(url, init));
    const api = new JetBrainsIdeApi({ fetch, now: () => NOW }), controller = new AbortController(), auth = { idToken, accountId: owner, sourceLicenseId };
    const first = api.licenses(auth, controller.signal), rejected = expect(first).rejects.toMatchObject({ code: 'cancelled' });
    const second = api.licenses(auth); controller.abort(); resolveProof(json({ token }));
    await rejected; expect(await second).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
