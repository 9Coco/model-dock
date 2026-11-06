import { describe, expect, it } from 'vitest';
import { createLicenseAssetDecoder, decodeLicenseAsset, parseStrictXml } from '../src/main/jetbrains-license-codec';

// Public AI Assistant 2026.2 SDK x serializer generated the XML. A fresh
// synthetic 512-bit RSA key encoded it; the official Z decoder and x DTO
// decoder independently recovered exactly this License/licenseKey. No actual
// account, license asset, credential or server signing key is used here.
const golden = {"modulus": "8865595117545099481975642996474992375919932098001217405647187913247054391326753396404534160656180117391689428236454458870873452495117824018729200240948923", "exponent": "65537", "xml": "<License><agreementAccepted>true</agreementAccepted><assetId>SYNTHETIC-ASSET</assetId><detectDuplicates>false</detectDuplicates><licenseKey>SYNTHETIC1234-eyJsaWNlbnNlSWQiOiJTWU5USEVUSUMxMjM0IiwiaGFzaCI6IkZSRUU6Zml4dHVyZSIsIm1ldGFkYXRhIjoiMDEyMDMwMDEwMVAtSi0tLS0tLS1BIiwicHJvZHVjdHMiOlt7ImNvZGUiOiJBSUEiLCJwYWlkVXBUbyI6IjIwMzEtMDItMDMifV19-AA==-AA==</licenseKey><licenseRestrictions></licenseRestrictions><licensedTo></licensedTo><productCode>AIA</productCode><productVersion>0</productVersion></License>", "encoded": "003EA93742435C65358C44E55C591C9DC036C5522B6C36433234FBC7426DA5EA23293A1B5E78BCDF3657CEA72BFFFC7EBF979A15F696D843248187879EA72F251C0050604E95133681B34237065746EF8A6314E68965DACDF3F800AAA10DCC1712289BAB04A47902609D508DFDF2397E20B2EB54F0D25AA5612A846AF1A9A42653CF0005804087A27897398B1DD74ABB1F24BB506E4E03B5F393A34056278B926194F2BD470D9A589CF06D7195ADC69138B1E31FD11EB6ECDD60ADF6F12EEEC1BAB35F00915E20E919D0E57DC480BE70C51191692063E346948B666A6E5FED2DAAF41C9F9C99686F85EFB2E1260DB3FC569EA974B8872E9F75444B813CC490F290F041CC0070CA8AA7843C71A249F8625ACCE0E791B94F95C23FFD3BA5E944A5893BFAEF31DA733B003BE82C3C251BC7D3B0739C695629817166C30BC8DFF15CFCBC8BAA970038CD6803838BCEF9826F015C48B6EA8372974704D7A95D291726F2D45C0CD39533C54269E138796C5BDE3B1A72EAB5F664FE04ED0752A33C413AB574F5015D11009573973AA65A8F73ED6D6ACB6CC4E940B216820A613EB76F1209C93B253CA5BC1F24B62E817ADE763A27F0249EAE3F74B0446DEE9EC39E725972D44230F589F1004FDCCAF37404553A166C9EC4596D7076D03B6F747184C8DCD5C95DEAE293D6B1A4BB2E2801A222511FBE30FEB3EC9D4A4D42EC60859D4605CFDE4C0A49E3A6BE"};
const expected = { id: 'SYNTHETIC1234', kind: 'FREE', licenseeType: 'INDIVIDUAL', licensePack: 'ALL_PRODUCTS_PACK', expiresOn: '2031-02-03', productCode: 'AIA' };
const identity = createLicenseAssetDecoder({ modulus: BigInt(golden.modulus), exponent: 1n });
function plainBlocks(xml: string): string {
  const bytes = Buffer.from(xml); let result = '';
  for (let start = 0; start < bytes.length; start += 63) result += bytes.subarray(start, start + 63).toString('hex').toUpperCase().padStart(130, '0');
  return result;
}
function payloadXml(change: Record<string, unknown>): string {
  const root = parseStrictXml(golden.xml), key = root.children.find(child => child.name === 'licenseKey')!.text, parts = key.split('-');
  const payload = { ...JSON.parse(Buffer.from(parts[1], 'base64').toString()), ...change };
  return golden.xml.replace(parts[1], Buffer.from(JSON.stringify(payload)).toString('base64'));
}

describe('official legacy JetBrains license asset wire', () => {
  it('matches independent installed public SDK serializer and RSA/XML decoder output', () => {
    const decode = createLicenseAssetDecoder({ modulus: BigInt(golden.modulus), exponent: BigInt(golden.exponent) });
    expect(decode(golden.encoded)).toEqual(expected);
    expect(decode(golden.encoded)).not.toHaveProperty('accountId');
    expect(JSON.stringify(decode(golden.encoded))).not.toMatch(/licenseKey|licensedTo|metadata|signature|certificate|<License>/);
  });
  it('uses the fixed official production key rather than accepting the synthetic testing key', () => {
    expect(() => decodeLicenseAsset(golden.encoded)).toThrow('许可证目录格式无效');
  });
  it.each(['', 'A', 'F'.repeat(130), '0'.repeat(130), 'a'.repeat(130), 'G'.repeat(130), '0'.repeat(1048580)])('rejects malformed, out-of-range or unbounded block input without echoing it', data => {
    expect(() => decodeLicenseAsset(data)).toThrow('许可证目录格式无效');
  });
  it('maps the native hash prefix, metadata licensee and pack indicators without guessing from quota', () => {
    expect(identity(plainBlocks(payloadXml({ hash: 'TRIAL:synthetic' })))).toMatchObject({ kind: 'TRIAL' });
    expect(identity(plainBlocks(payloadXml({ hash: 'regular-hash', metadata: '0120300101C-J-------D' })))).toMatchObject({ kind: 'STANDARD', licenseeType: 'COMPANY', licensePack: 'DOTULTIMATE' });
    expect(identity(plainBlocks(payloadXml({ metadata: '0120300101E-J-------S' })))).toMatchObject({ licenseeType: 'STUDENT', licensePack: 'STUDENT' });
    expect(identity(plainBlocks(payloadXml({ metadata: '0120300101L-J--------' })))).toMatchObject({ licenseeType: 'CLASSROOM', licensePack: 'NONE' });
  });
  it.each([
    { licenseId: 'DIFFERENT' }, { hash: null }, { metadata: 'unknown' }, { metadata: '0120300231P-J-------A' }, { metadata: '0120300101P-X-------A' },
    { products: [] }, { products: [{ code: 'IDE', paidUpTo: '2031-02-03' }] }, { products: [{ code: 'AIA', paidUpTo: '2031-02-30' }] },
    { products: [{ code: 'AIA', paidUpTo: '2031-02-03' }, { code: 'AIA', paidUpTo: '2031-02-03' }] },
  ])('refuses mismatched or ambiguous official metadata: %j', change => {
    expect(() => identity(plainBlocks(payloadXml(change)))).toThrow('许可证目录格式无效');
  });
  it('rejects duplicate license fields and never includes decoded private metadata in errors', () => {
    const xml = golden.xml.replace('</License>', '<licenseKey>PRIVATE_UNTRUSTED_KEY</licenseKey></License>');
    try { identity(plainBlocks(xml)); throw new Error('Expected refusal'); } catch (error) { expect(String(error)).toContain('许可证目录格式无效'); expect(String(error)).not.toContain('PRIVATE'); }
  });
});

describe('bounded strict XML for official legacy response envelopes', () => {
  it('preserves direct text, escaped values, CDATA and empty fields in the official wrapper shape', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><ObtainLicenseResponse><assets><EncodedAsset><data>A&amp;B&#x4E2D;<![CDATA[<>]]></data></EncodedAsset></assets><responseCode>OK</responseCode><message a="&quot;"/></ObtainLicenseResponse>';
    const root = parseStrictXml(xml); expect(root.name).toBe('ObtainLicenseResponse'); expect(root.text).toBe('');
    expect(root.children[0].children[0].children[0].text).toBe('A&B中<>'); expect(root.children[2].attributes.a).toBe('"');
  });
  it.each([
    '<!DOCTYPE x SYSTEM "file:///private"><x/>', '<!DOCTYPE x [<!ENTITY private "private">]><x>&private;</x>',
    '<x>&unknown;</x>', '<x>&#0;</x>', '<x>&#xD800;</x>', '<x>&#x110000;</x>', '<x a="1" a="2"/>',
    '<x><y></x>', '<x/><y/>', '<?processing private?><x/>', '<x><!-- bad--comment --></x>', '<x><![CDATA[unterminated</x>',
    '<x a="raw<value"/>', '<x>bad]]></x>', '<x>'.repeat(25) + '</x>'.repeat(25), '<x>' + '<y/>'.repeat(10000) + '</x>',
  ])('rejects unsafe or malformed envelope syntax', xml => { expect(() => parseStrictXml(xml)).toThrow('许可证目录格式无效'); });
  it('enforces declared parser byte bounds and valid Unicode', () => {
    expect(() => parseStrictXml('<x>中文</x>', 8)).toThrow(); expect(() => parseStrictXml('<x>\ud800</x>')).toThrow();
  });
});
