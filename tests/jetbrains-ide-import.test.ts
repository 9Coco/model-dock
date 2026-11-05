import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJetBrainsIdToken, decodeJetBrainsPreferenceValue, JetBrainsIdeImporter, JetBrainsIdeImportError, parseJetBrainsAiLicense, parseJetBrainsPreferences } from '../src/main/jetbrains-ide-import';

// Independent Java producer; official JDK Preferences created synthetic XML
// under an explicitly isolated user.home and java.util.prefs.userRoot.
const GOLDEN = {"source":"Independent Java producer with verified native mask/MIME Base64; official JDK Preferences wrote isolated synthetic XML","token":"eyJhbGciOiJSUzI1NiIsImtpZCI6IlNZTlRIRVRJQ19GSVhUVVJFX09OTFkifQ.eyJ1c2VyX2lkIjoiZml4dHVyZS1qYmEtdXNlciIsImpiYV9sb2dpbiI6ImZpeHR1cmUubG9naW4iLCJlbWFpbCI6ImZpeHR1cmVAZXhhbXBsZS5pbnZhbGlkIiwiZnVsbF9uYW1lIjoiRml4dHVyZSDnlKjmiLciLCJpc3MiOiJodHRwczovL2FjY291bnQuamV0YnJhaW5zLmNvbSIsInN1YiI6ImZpeHR1cmUtc3ViamVjdCIsImF1ZCI6IlNZTlRIRVRJQ19JREVfQVVESUVOQ0UiLCJleHAiOjE4OTM0NTYwMDB9.U1lOVEhFVElDX1NJR05BVFVSRV9PTkxZ","wrapped":"MREvSCY1Ch8qST48dT4sRysFJgNnORwVegc7Xz8Jbi47TBYsJDM+JSEfbS82diwnPyAvZixfGQsx\nMA4FCSEAMREvESdAPw89EhgEaS4KHz8BA0RKHD4cehdDGC8IZQALeAoJFQwlHDlDJAE8dn0BC0QB\nUBYGaXIsGz8cCjh8ZQsIdTEQLk8LQSNbSQgmPAkOODZeNissFg0fMwYAaCZeQykzNz80BxhMDCoW\nehdHGRQLehwNZygOPwwbBipAAhsHZn0HMCFUTD0FTy03GwlYCzh4LTI2ZCoeIhwISTgMSQgmPBUP\nXD1HGwEvTyA6OwEGWhsZbHYjHDxeVkFMOjkQQSkkWS8LahwOd3EfOggiGRJ9HRssTgpDMB8sFj0C\nejQAPjddDB17IAtWdi0TBCAPRDcmUw0IMFQ2LDkYHQQrehAeOz83diYlcXVcPDcpORZ/Aj4gcxEk\nJidVdR0jYw4JEy0tBj9EEVwqdAlCJyI8VzkrYn1LI1QAICZrPC4zZSg2MUcraiZfFQYzMDM/PSYX\nBDwOWB4=","xml":"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<!DOCTYPE map SYSTEM \"http://java.sun.com/dtd/preferences.dtd\">\n<map MAP_XML_VERSION=\"1.0\">\n  <entry key=\"idtoken\" value=\"MREvSCY1Ch8qST48dT4sRysFJgNnORwVegc7Xz8Jbi47TBYsJDM+JSEfbS82diwnPyAvZixfGQsx&#13;&#10;MA4FCSEAMREvESdAPw89EhgEaS4KHz8BA0RKHD4cehdDGC8IZQALeAoJFQwlHDlDJAE8dn0BC0QB&#13;&#10;UBYGaXIsGz8cCjh8ZQsIdTEQLk8LQSNbSQgmPAkOODZeNissFg0fMwYAaCZeQykzNz80BxhMDCoW&#13;&#10;ehdHGRQLehwNZygOPwwbBipAAhsHZn0HMCFUTD0FTy03GwlYCzh4LTI2ZCoeIhwISTgMSQgmPBUP&#13;&#10;XD1HGwEvTyA6OwEGWhsZbHYjHDxeVkFMOjkQQSkkWS8LahwOd3EfOggiGRJ9HRssTgpDMB8sFj0C&#13;&#10;ejQAPjddDB17IAtWdi0TBCAPRDcmUw0IMFQ2LDkYHQQrehAeOz83diYlcXVcPDcpORZ/Aj4gcxEk&#13;&#10;JidVdR0jYw4JEy0tBj9EEVwqdAlCJyI8VzkrYn1LI1QAICZrPC4zZSg2MUcraiZfFQYzMDM/PSYX&#13;&#10;BDwOWB4=\"/>\n  <entry key=\"unrelated\" value=\"A&amp;B &lt;not imported&gt;\"/>\n  <entry key=\"userid\" value=\"MgEdVDEADFsPQhVCVTcABA==\"/>\n  <entry key=\"userlogin\" value=\"MgEdVDEADFgJTxMGTg==\"/>\n</map>\n"};
const NOW = Date.parse('2026-11-05T10:00:00Z'), directories: string[] = [];
const mask = Buffer.from('The Drive to Develop.');
function wrap(value: string) { const bytes = Buffer.from(value); for (let i = 0; i < bytes.length; i++) bytes[i] ^= mask[i % mask.length]; return bytes.toString('base64'); }
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;').replaceAll('\n', '&#10;');
function authXml(changes: Record<string, unknown> = {}, userId?: string) {
  const claims = { ...JSON.parse(Buffer.from(GOLDEN.token.split('.')[1], 'base64url').toString()), ...changes };
  const token = [GOLDEN.token.split('.')[0], Buffer.from(JSON.stringify(claims)).toString('base64url'), GOLDEN.token.split('.')[2]].join('.');
  return `<map MAP_XML_VERSION="1.0"><entry key="idtoken" value="${escape(wrap(token))}"/><entry key="userid" value="${escape(wrap(userId ?? String(claims.user_id)))}"/><entry key="userlogin" value="${escape(wrap('fixture.login'))}"/></map>`;
}
function licenseXml(licenseId = 'fixture-license-aip', extra = '') { return `<application><component name="AipLicense"><option name="licenseId" value="${escape(licenseId)}"/>${extra}</component><component name="Unrelated"><option name="apiKey" value="SYNTHETIC_PRIVATE_OTHER_SETTING"/></component></application>`; }
function jcpXml(type: string, userId = 'fixture-jba-user', licenseId = 'current-jcp-license', legacyId = 'old-legacy-license') {
  return licenseXml(legacyId).replace('</application>', `<component name="JcpWorkspaceSelection"><option name="accessType" value="${escape(type)}"/><option name="accessUserId" value="${escape(userId)}"/><option name="accessLicenseId" value="${escape(licenseId)}"/><option name="accessWorkspaceId" value="fixture-workspace"/></component></application>`);
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'modeldock-jba-reader-')); directories.push(home);
  const prefs = join(home, '.java/.userPrefs/jetbrains/jetprofile/prefs.xml');
  const profile = join(home, '.config/JetBrains/IntelliJIdea2026.2/options/other.xml');
  await mkdir(join(home, '.java/.userPrefs/jetbrains/jetprofile'), { recursive: true });
  await mkdir(join(home, '.config/JetBrains/IntelliJIdea2026.2/options'), { recursive: true });
  let clock = NOW;
  const reader = new JetBrainsIdeImporter({ homeDir: home, platform: 'linux', env: {}, now: () => clock });
  return { home, prefs, profile, reader, advance: (ms: number) => { clock += ms; }, write: async (xml = GOLDEN.xml, license = licenseXml()) => { await writeFile(prefs, xml); await writeFile(profile, license); } };
}
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('native JBA preference envelope and narrowly scoped XML', () => {
  it('decodes independent Java/JDK golden values with MIME line wrapping', () => {
    const values = parseJetBrainsPreferences(GOLDEN.xml);
    expect(Object.keys(values).sort()).toEqual(['idtoken', 'userid', 'userlogin']);
    expect(decodeJetBrainsIdToken(values.idtoken!)).toBe(GOLDEN.token);
    expect(decodeJetBrainsPreferenceValue(values.userid!)).toBe('fixture-jba-user');
    expect(decodeJetBrainsPreferenceValue(values.userlogin!)).toBe('fixture.login');
    expect(decodeJetBrainsIdToken(GOLDEN.wrapped)).toBe(GOLDEN.token);
  });
  it('does not fetch DTDs or accept external entities, duplicated target slots, malformed maps or bare tokens', () => {
    for (const xml of ['<!DOCTYPE map SYSTEM "https://evil.invalid/exfil"><map MAP_XML_VERSION="1.0"/>', '<!DOCTYPE map [<!ENTITY secret SYSTEM "file:///private">]><map MAP_XML_VERSION="1.0"/>', '<map MAP_XML_VERSION="1.0"><entry key="idtoken" value="x"/><entry key="idtoken" value="y"/></map>', '<map MAP_XML_VERSION="1.0"><entry key="idtoken" value="&unknown;"/></map>', '<map MAP_XML_VERSION="unknown"/>', '<map MAP_XML_VERSION="1.0"><entry key="idtoken" value="x"></map>']) {
      expect(() => parseJetBrainsPreferences(xml)).toThrow(JetBrainsIdeImportError);
    }
    expect(() => decodeJetBrainsIdToken(GOLDEN.token)).toThrow(JetBrainsIdeImportError);
    expect(() => decodeJetBrainsIdToken('x'.repeat(65537))).toThrow(JetBrainsIdeImportError);
    expect(parseJetBrainsPreferences('<map MAP_XML_VERSION="1.0"/>')).toEqual({});
    expect(parseJetBrainsPreferences('<map MAP_XML_VERSION="1.0"><entry key="userlogin" value="A&amp;B&#10;C"/></map>').userlogin).toBe('A&B\nC');
  });
  it('reads exactly the selected AipLicense option and skips comments, CDATA, nested and unrelated fields', () => {
    const xml = `<?xml version="1.0"?><application><!--<component name="AipLicense"><option name="licenseId" value="wrong"/></component>--><component name="Other"><![CDATA[<component name="AipLicense"><option name="licenseId" value="wrong"/></component>]]><option name="licenseId" value="wrong"/></component><component name="AipLicense"><option name="licenseId" value="fixture-license-aip"/><option name="jbaActivationIntended" value="true"/></component></application>`;
    expect(parseJetBrainsAiLicense(xml)).toBe('fixture-license-aip');
    expect(parseJetBrainsAiLicense(licenseXml('fixture-license-aip', '<option name="forciblyLoggedOut" value="true"/>'))).toBeUndefined();
    expect(parseJetBrainsAiLicense('<application><component name="Other"><option name="licenseId" value="wrong"/></component></application>')).toBeUndefined();
  });
  it('refuses ambiguous, unsafe or malformed license XML instead of guessing a license', () => {
    for (const xml of [licenseXml('a', '<option name="licenseId" value="b"/>'), '<application><component name="AipLicense"/><component name="AipLicense"/></application>', '<!DOCTYPE application SYSTEM "file:///private"><application/>', '<application><component name="AipLicense"><option name="licenseId" value="bad/path"/></component></application>', '<application><component name="AipLicense"></application>', '<application/><application/>']) expect(() => parseJetBrainsAiLicense(xml)).toThrow(JetBrainsIdeImportError);
  });
  it('uses the explicit JCP license only for its bound current account, with legacy fallback only for an empty selection', () => {
    expect(parseJetBrainsAiLicense(jcpXml('license'), 'fixture-jba-user')).toBe('current-jcp-license');
    expect(parseJetBrainsAiLicense(jcpXml(''), 'fixture-jba-user')).toBe('old-legacy-license');
    expect(() => parseJetBrainsAiLicense(jcpXml('license'), 'another-user')).toThrow('账号与');
    expect(() => parseJetBrainsAiLicense(jcpXml('license', 'fixture-jba-user', ''), 'fixture-jba-user')).toThrow(JetBrainsIdeImportError);
    expect(() => parseJetBrainsAiLicense(jcpXml('workspace'), 'fixture-jba-user')).toThrow('不会改用旧');
    expect(() => parseJetBrainsAiLicense(jcpXml('unknown'), 'fixture-jba-user')).toThrow(JetBrainsIdeImportError);
  });
  it.each(['forciblyLoggedOut', 'isForciblyLoggedOut'])('respects the native logout spelling %s and rejects duplicate or conflicting flags', name => {
    expect(parseJetBrainsAiLicense(licenseXml('fixture-license-aip', `<option name="${name}" value="true"/>`))).toBeUndefined();
    expect(parseJetBrainsAiLicense(licenseXml('fixture-license-aip', `<option name="${name}" value="false"/>`))).toBe('fixture-license-aip');
    expect(() => parseJetBrainsAiLicense(licenseXml('fixture-license-aip', `<option name="${name}" value="false"/><option name="${name}" value="false"/>`))).toThrow(JetBrainsIdeImportError);
    expect(() => parseJetBrainsAiLicense(licenseXml('fixture-license-aip', '<option name="forciblyLoggedOut" value="false"/><option name="isForciblyLoggedOut" value="true"/>'))).toThrow(JetBrainsIdeImportError);
    expect(parseJetBrainsAiLicense(licenseXml('fixture-license-aip', '<option name="forciblyLoggedOut" value="true"/><option name="isForciblyLoggedOut" value="true"/>'))).toBeUndefined();
  });
});

describe('explicit Linux IDE account and license selection', () => {
  it('does no work at construction, previews opaque metadata only and preserves source bytes', async () => {
    const f = await fixture(); expect(await f.reader.listCandidates()).toEqual([]); await f.write();
    const before = [await readFile(f.prefs), await readFile(f.profile)];
    const candidates = await f.reader.listCandidates(); expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ client: 'jetbrains-ide', product: 'intellij-idea', accountId: 'fixture-jba-user', accountLabel: 'Fixture 用户', sourceTokenExpHint: Date.parse('2030-01-01T00:00:00Z') });
    expect(candidates[0].id).toMatch(/^[a-f0-9-]{36}$/); expect(candidates[0].sourceIdentity).toMatch(/^jetbrains-ide:intellij-idea:[a-f0-9]{64}$/);
    expect(JSON.stringify(candidates)).not.toMatch(/SYNTHETIC_PRIVATE|SIGNATURE|idtoken|eyJ|fixture-license-aip|prefs\.xml/);
    const credential = await f.reader.readCredentials(candidates[0].id);
    expect(credential).toMatchObject({ authorization: 'unverified', tokenType: 'jba-id-token', idToken: GOLDEN.token, licenseId: 'fixture-license-aip', accountId: 'fixture-jba-user', product: 'intellij-idea' });
    expect(credential).not.toHaveProperty('refreshToken'); expect(credential).not.toHaveProperty('accessToken');
    expect([await readFile(f.prefs), await readFile(f.profile)]).toEqual(before);
  });
  it('offers only fixed 2026.2 profiles with a selected license and provides stable product/license identities across previews', async () => {
    const f = await fixture(); await f.write();
    for (const [profile, license] of [['WebStorm2026.2', 'web-license'], ['Rider2026.2', 'rider-license'], ['PyCharm2026.2', 'py-license'], ['IntelliJIdea2026.1', 'old-ignored']]) {
      const dir = join(f.home, '.config/JetBrains', profile, 'options'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'other.xml'), licenseXml(license));
    }
    const first = await f.reader.listCandidates(), second = await f.reader.listCandidates();
    expect(first.map(candidate => candidate.product)).toEqual(['intellij-idea', 'webstorm', 'rider', 'pycharm']);
    expect(first.map(candidate => candidate.sourceIdentity)).toEqual(second.map(candidate => candidate.sourceIdentity)); expect(first.map(candidate => candidate.id)).not.toEqual(second.map(candidate => candidate.id));
    expect(new Set(first.map(candidate => candidate.sourceIdentity)).size).toBe(4);
  });
  it('requires a selected AI license and respects explicit IDE logout instead of asking the user to guess an ID', async () => {
    const f = await fixture(); await f.write(GOLDEN.xml, '<application><component name="AipLicense"/></application>');
    await expect(f.reader.listCandidates()).rejects.toThrow('选择本人许可证');
    await writeFile(f.profile, licenseXml('fixture-license-aip', '<option name="forciblyLoggedOut" value="true"/>'));
    await expect(f.reader.listCandidates()).rejects.toThrow('选择本人许可证');
  });
  it('keeps an absent native exp unknown and still returns only an unverified identity token', async () => {
    const f = await fixture(); await f.write(authXml({ exp: undefined }));
    const [candidate] = await f.reader.listCandidates(); expect(candidate).not.toHaveProperty('sourceTokenExpHint'); expect(candidate).not.toHaveProperty('expiresAt');
    const credential = await f.reader.readCredentials(candidate.id);
    expect(credential).toMatchObject({ authorization: 'unverified', tokenType: 'jba-id-token' });
    expect(credential).not.toHaveProperty('sourceTokenExpHint'); expect(credential).not.toHaveProperty('expiresAt'); expect(credential).not.toHaveProperty('accessToken');
  });
  it('passes a past-exp native identity assertion unchanged as unverified input to official validation, never as an expired access credential', async () => {
    const f = await fixture(); await f.write(authXml({ exp: 1577836800, nbf: 1999999999 }));
    const [candidate] = await f.reader.listCandidates(); expect(candidate.sourceTokenExpHint).toBe(Date.parse('2020-01-01T00:00:00Z'));
    const credential = await f.reader.readCredentials(candidate.id);
    expect(credential).toMatchObject({ authorization: 'unverified', tokenType: 'jba-id-token', sourceTokenExpHint: Date.parse('2020-01-01T00:00:00Z') });
    expect(credential).not.toHaveProperty('expiresAt'); expect(credential).not.toHaveProperty('accessToken');
    expect(JSON.parse(Buffer.from(credential.idToken.split('.')[1], 'base64url').toString()).exp).toBe(1577836800);
  });
  it.each([null, '1893456000', -1, Infinity, 253402300800])('keeps nonauthoritative source exp %s unknown instead of inventing a deadline', async exp => {
    const f = await fixture(); await f.write(authXml({ exp }));
    const [candidate] = await f.reader.listCandidates(); expect(candidate).not.toHaveProperty('sourceTokenExpHint');
    expect(await f.reader.readCredentials(candidate.id)).not.toHaveProperty('expiresAt');
  });
  it('binds candidate and confirmation to the active JCP account/license and rejects workspace changes without falling back', async () => {
    const f = await fixture(); await f.write(GOLDEN.xml, jcpXml('license'));
    const [candidate] = await f.reader.listCandidates(); expect((await f.reader.readCredentials(candidate.id)).licenseId).toBe('current-jcp-license');
    await writeFile(f.profile, jcpXml('workspace')); await expect(f.reader.readCredentials(candidate.id)).rejects.toThrow('不会改用旧');
    await expect(f.reader.listCandidates()).rejects.toThrow('不会改用旧');
    await writeFile(f.profile, jcpXml('license', 'another-user')); await expect(f.reader.listCandidates()).rejects.toThrow('账号与');
    await writeFile(f.profile, jcpXml('license', 'fixture-jba-user', 'changed-license')); await expect(f.reader.readCredentials(candidate.id)).rejects.toThrow('切换');
  });
  it.each(['account', 'license', 'logout'] as const)('re-reads and rejects a %s change after the preview', async change => {
    const f = await fixture(); await f.write(); const [candidate] = await f.reader.listCandidates();
    if (change === 'account') await writeFile(f.prefs, authXml({ user_id: 'different-user', sub: 'different-subject' }));
    else await writeFile(f.profile, change === 'license' ? licenseXml('different-license') : licenseXml('fixture-license-aip', '<option name="forciblyLoggedOut" value="true"/>'));
    await expect(f.reader.readCredentials(candidate.id)).rejects.toThrow(/切换|变化/);
  });
  it('rejects expired selection tickets, missing/mismatched identities and unsigned tokens without leaking material', async () => {
    const f = await fixture(); await f.write(); const [candidate] = await f.reader.listCandidates(); f.advance(5 * 60_000);
    await expect(f.reader.readCredentials(candidate.id)).rejects.toThrow('选择已过期');
    await expect(f.reader.readCredentials('../../private')).rejects.toThrow('选择已过期');
    for (const [claims, userId] of [[{ user_id: '' }, undefined], [{}, 'wrong-user']] as const) {
      await writeFile(f.prefs, authXml(claims, userId)); const error = await f.reader.listCandidates().catch(error => error as Error);
      expect(error).toBeInstanceOf(JetBrainsIdeImportError); expect(String(error)).not.toContain(GOLDEN.token); expect(String(error)).not.toContain(f.prefs);
    }
    const [header, payload, signature] = GOLDEN.token.split('.');
    const none = [Buffer.from('{"alg":"none"}').toString('base64url'), payload, signature].join('.');
    await writeFile(f.prefs, `<map MAP_XML_VERSION="1.0"><entry key="idtoken" value="${wrap(none)}"/></map>`);
    await expect(f.reader.listCandidates()).rejects.toThrow('格式无法识别'); expect(header).toBeTruthy();
  });
  it('rejects oversized credential sources', async () => {
    const f = await fixture(); await f.write(); await writeFile(f.prefs, 'x'.repeat(1048577)); await expect(f.reader.listCandidates()).rejects.toBeInstanceOf(JetBrainsIdeImportError);
  });
  it('rejects symlinked credential or profile sources and does not scan alternative stores', async ({ skip }) => {
    const f = await fixture(); await f.write();
    await rm(f.prefs); const foreign = join(f.home, 'foreign'); await writeFile(foreign, GOLDEN.xml);
    try { await symlink(foreign, f.prefs); }
    catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { skip('Windows does not permit creating file symlinks for this user.'); return; } throw error; }
    await expect(f.reader.listCandidates()).rejects.toBeInstanceOf(JetBrainsIdeImportError);
    await rm(f.prefs); await writeFile(f.prefs, GOLDEN.xml); await rm(f.profile); await symlink(foreign, f.profile);
    await expect(f.reader.listCandidates()).rejects.toBeInstanceOf(JetBrainsIdeImportError); expect(await readFile(foreign, 'utf8')).toBe(GOLDEN.xml);
  });
  it('uses only an explicitly configured XDG root and refuses unsupported native backends', async () => {
    const f = await fixture(); await f.write();
    const alternate = new JetBrainsIdeImporter({ homeDir: f.home, platform: 'linux', env: { XDG_CONFIG_HOME: join(f.home, 'empty-config') }, now: () => NOW });
    await expect(alternate.listCandidates()).rejects.toThrow('选择本人许可证');
    await expect(new JetBrainsIdeImporter({ homeDir: f.home, platform: 'darwin' }).listCandidates()).rejects.toThrow('尚未完成原生验证');
  });
});
