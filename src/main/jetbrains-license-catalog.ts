import { randomUUID } from 'node:crypto';
import type { JetBrainsIdeLicense } from './jetbrains-ide-api';
import { decodeLicenseAsset, parseStrictXml, type StrictXmlNode } from './jetbrains-license-codec';

const ORIGIN = 'https://account.jetbrains.com';
const LIMIT = 4 * 1024 * 1024;
// Supported 2026.2 AI plugin product-descriptor: release-version=2026200,
// release-date=20260716. Native sends yyyyMMdd, not Unix milliseconds.
/** Public AipProductType codes, also used by the installed native repository.
 * These are products returned by a catalog query, never guesses from credits. */
const PRODUCTS = [
  ['AIPU', 'JetBrains AI Ultimate'], ['AIP', 'JetBrains AI Pro'],
  ['AIPEAP', 'JetBrains AI EAP'], ['AIF', 'JetBrains AI Free'],
] as const;
export class JetBrainsLicenseCatalogError extends Error {
  constructor(readonly code: 'network' | 'response' | 'cancelled' | 'limit') { super('JetBrains 许可证目录暂时无法核验，请稍后重试。'); }
}
const fail = (code: JetBrainsLicenseCatalogError['code']): never => { throw new JetBrainsLicenseCatalogError(code); };
function child(node: StrictXmlNode, name: string): StrictXmlNode {
  const matches = node.children.filter(value => value.name === name);
  if (matches.length !== 1) fail('response');
  return matches[0];
}
function scalar(node: StrictXmlNode): string {
  if (node.children.length || Object.keys(node.attributes).length) fail('response');
  return node.text.trim();
}
async function body(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > LIMIT || !response.body) { await response.body?.cancel().catch(() => {}); fail('limit'); }
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let count = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) fail('cancelled');
      const part = await reader.read(); if (part.done) break;
      count += part.value.byteLength; if (count > LIMIT) { await reader.cancel().catch(() => {}); fail('limit'); }
      chunks.push(part.value);
    }
    if (signal.aborted) fail('cancelled');
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

/** Read-only native getAvailableLicenses wire. This is not obtainTrial,
 * registration, activation, or a client-configuration operation. The caller
 * must first authorize the unchanged source license with the official AI API.
 * ID/access tokens are deliberately never sent to this licensing origin. */
export async function readJetBrainsIdeLicenseCatalog(input: {
  fetch: typeof globalThis.fetch; accountId: string; version: string; now: () => number; signal: AbortSignal;
}): Promise<JetBrainsIdeLicense[]> {
  const machine = 'ModelDock-' + randomUUID();
  try {
    const groups = await Promise.all(PRODUCTS.map(async ([productCode, plan]) => {
      const salt = String(input.now());
      const url = new URL('/lservice/rpc/obtainLicense.action', ORIGIN);
      url.search = new URLSearchParams({ buildDate: '20260716', buildNumber: 'ModelDock-' + input.version,
        clientVersion: '22', expiredLicenseDays: '0', hostName: 'ModelDock', ideProductCode: 'ModelDock',
        machineId: machine, machineUUID: machine, productCode, productFamilyId: productCode,
        salt, secure: 'false', userId: input.accountId, userName: 'ModelDock', version: '2026200' }).toString();
      if (input.signal.aborted) fail('cancelled');
      let response: Response;
      try { response = await input.fetch(url, { method: 'GET', headers: { Accept: 'application/xml,text/xml', 'User-Agent': 'ModelDock/' + input.version },
        signal: input.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }); }
      catch { fail(input.signal.aborted ? 'cancelled' : 'network'); }
      if (!response!.ok || response!.redirected || response!.url && new URL(response!.url).origin !== ORIGIN) {
        await response!.body?.cancel().catch(() => {}); fail('network');
      }
      const xml = parseStrictXml(await body(response!, input.signal));
      if (xml.name !== 'ObtainLicenseResponse' || Object.keys(xml.attributes).length || xml.text.trim()
        || scalar(child(xml, 'responseCode')) !== 'OK' || scalar(child(xml, 'salt')) !== salt
        || scalar(child(xml, 'action')) !== 'NONE') fail('response');
      const assets = child(xml, 'assets');
      if (Object.keys(assets.attributes).length || assets.text.trim() || assets.children.length > 128) fail('response');
      const licenses: JetBrainsIdeLicense[] = [];
      for (const asset of assets.children) {
        if (asset.name !== 'EncodedAsset' || Object.keys(asset.attributes).length || asset.text.trim() || asset.children.length !== 1) fail('response');
        const receipt = decodeLicenseAsset(scalar(child(asset, 'data')));
        if (receipt.productCode !== productCode) fail('response');
        // Expiration and owner eligibility have already been selected by the
        // official product-specific, zero-expired-days query. Each returned
        // license still needs its own server exchange before it can be saved.
        licenses.push({ id: receipt.id, plan, productCode, kind: receipt.kind, ...(receipt.expiresOn ? { expiresAt: receipt.expiresOn } : {}) });
      }
      return licenses;
    }));
    const rows = new Map<string, JetBrainsIdeLicense>();
    for (const group of groups) {
      const seen = new Set<string>();
      for (const row of group) {
        if (seen.has(row.id)) fail('response'); seen.add(row.id);
        const previous = rows.get(row.id);
        // Native AipLicenseEligibilityKt / JbaiLicenseStoreState uses this
        // exact priority and keeps the first licenseId across product views.
        // A single license can include lower-tier product access: the native
        // service also returns Ultimate under Pro, and Pro under Free. Keep
        // the explicitly returned more specific product, never add its quota
        // again. Conflicting dates/kinds are not silently merged.
        if (previous && (previous.kind !== row.kind || previous.expiresAt !== row.expiresAt)) fail('response');
        if (!previous) rows.set(row.id, row);
      }
    }
    if (rows.size > 128) fail('response');
    return [...rows.values()];
  } catch (error) { throw error instanceof JetBrainsLicenseCatalogError ? error : new JetBrainsLicenseCatalogError(input.signal.aborted ? 'cancelled' : 'response'); }
}
