/** Read-only legacy licensing wire metadata. This is not an offline license
 * authorization engine: the caller must verify its source with the official
 * service and exchange each exact target license before saving it. */
export interface StrictXmlNode { name: string; attributes: Record<string, string>; children: StrictXmlNode[]; text: string }
export interface JetBrainsLicenseReceipt {
  id: string;
  kind: 'STANDARD' | 'TRIAL' | 'FREE';
  licenseeType: 'INDIVIDUAL' | 'COMPANY' | 'STUDENT' | 'CLASSROOM' | 'UNKNOWN';
  licensePack: 'NONE' | 'ALL_PRODUCTS_PACK' | 'DOTULTIMATE' | 'STUDENT';
  /** Official product paidUpTo date, kept date-only without inventing a zone. */
  expiresOn?: string;
  productCode?: string;
}
type CodecStage = 'input' | 'block' | 'utf8' | 'xml' | 'license-key' | 'base64' | 'json' | 'metadata' | 'product';
export class JetBrainsLicenseCodecError extends Error {
  constructor(readonly stage: CodecStage) { super('JetBrains 许可证目录格式无效，未采用该结果。'); this.name = 'JetBrainsLicenseCodecError'; }
}
const invalid = (stage: CodecStage = 'xml') => new JetBrainsLicenseCodecError(stage);
const MAX_ASSET = 1024 * 1024, MAX_XML = 4 * 1024 * 1024;
const validCharacters = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value) && Buffer.from(value).toString('utf8') === value;
function entities(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value)) throw invalid();
  return value.replace(/&([^;]+);/g, (_match, entity: string) => {
    const standard: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(standard, entity)) return standard[entity];
    const code = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw invalid();
    const result = String.fromCodePoint(code); if (!validCharacters(result)) throw invalid(); return result;
  });
}
/** Deliberately excludes DTDs, external entities and arbitrary processing
 * instructions. text contains direct text only; children retain their order. */
export function parseStrictXml(xml: string, maxBytes = MAX_XML): StrictXmlNode {
  if (typeof xml !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_XML || Buffer.byteLength(xml) > maxBytes || !validCharacters(xml)) throw invalid();
  let offset = xml.charCodeAt(0) === 0xfeff ? 1 : 0, root: StrictXmlNode | undefined, count = 0;
  const stack: StrictXmlNode[] = [];
  if (xml.startsWith('<?xml', offset)) {
    const declaration = /^<\?xml\s+version=(?:"1\.0"|'1\.0')(?:\s+encoding=(?:"UTF-8"|'UTF-8'))?(?:\s+standalone=(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/i.exec(xml.slice(offset));
    if (!declaration) throw invalid(); offset += declaration[0].length;
  }
  while (offset < xml.length) {
    if (xml.startsWith('<!--', offset)) { const end = xml.indexOf('-->', offset + 4); if (end < 0 || xml.slice(offset + 4, end).includes('--')) throw invalid(); offset = end + 3; continue; }
    if (xml.startsWith('<![CDATA[', offset)) { const end = xml.indexOf(']]>', offset + 9); if (end < 0 || !stack.length) throw invalid(); stack.at(-1)!.text += xml.slice(offset + 9, end); offset = end + 3; continue; }
    if (xml[offset] !== '<') {
      const end = xml.indexOf('<', offset), value = xml.slice(offset, end < 0 ? xml.length : end);
      if (value.includes(']]>')) throw invalid();
      if (stack.length) stack.at(-1)!.text += entities(value); else if (value.trim()) throw invalid();
      offset = end < 0 ? xml.length : end; continue;
    }
    const close = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(xml.slice(offset));
    if (close) { if (stack.pop()?.name !== close[1]) throw invalid(); offset += close[0].length; continue; }
    const open = /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(offset));
    if (!open || ++count > 10_000 || stack.length >= 24) throw invalid();
    offset += open[0].length;
    const node: StrictXmlNode = { name: open[1], attributes: Object.create(null), children: [], text: '' };
    let selfClosing = false, attributes = 0;
    while (true) {
      if (xml.startsWith('/>', offset)) { selfClosing = true; offset += 2; break; }
      if (xml[offset] === '>') { offset++; break; }
      const attr = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(xml.slice(offset));
      if (!attr) { const tail = /^\s+(?=\/?>)/.exec(xml.slice(offset)); if (tail) { offset += tail[0].length; continue; } throw invalid(); }
      if (++attributes > 32 || Object.hasOwn(node.attributes, attr[1])) throw invalid();
      node.attributes[attr[1]] = entities(attr[2] ?? attr[3]); offset += attr[0].length;
    }
    if (stack.length) stack.at(-1)!.children.push(node); else { if (root) throw invalid(); root = node; }
    if (!selfClosing) stack.push(node);
  }
  if (stack.length || !root) throw invalid(); return root;
}
function pow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let value = 1n; for (; exponent; exponent >>= 1n) { if (exponent & 1n) value = value * base % modulus; base = base * base % modulus; } return value;
}
const PUBLIC_MODULUS = 8507932990424784964569684563236672126164313504336131880227909327517047206934644515650823899568839233149672339972638419532910579908273480459901956369943667n;
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/+]*$/.test(value) && value.length <= 256; }
function date(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const parsed = new Date(value + 'T00:00:00Z'); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}
function documentReceipt(xml: string): JetBrainsLicenseReceipt {
  const root = parseStrictXml(xml, MAX_ASSET);
  if (root.name !== 'License' || root.text.trim() || Object.keys(root.attributes).length) throw invalid();
  const fields = new Map<string, string>();
  for (const child of root.children) { if (fields.has(child.name) || child.children.length || Object.keys(child.attributes).length) throw invalid(); fields.set(child.name, child.text); }
  const key = fields.get('licenseKey'), code = fields.get('productCode');
  if (!key || key.length > 256 * 1024 || !code || !identifier(code)) throw invalid('license-key');
  const parts = key.split('-');
  if (parts.length !== 4 || !identifier(parts[0])) throw invalid('license-key');
  if (parts.slice(1).some(part => !part || !/^[A-Za-z0-9+/]+={0,2}$/.test(part) || part.length % 4 || Buffer.from(part, 'base64').toString('base64') !== part)) throw invalid('base64');
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[1], 'base64'))); } catch { throw invalid('json'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.licenseId !== parts[0] || typeof payload.hash !== 'string' || payload.hash.length > 256 || typeof payload.metadata !== 'string' || payload.metadata.length > 1024) throw invalid('metadata');
  const metadata = payload.metadata;
  if (metadata.length < 20 || !/^\d{2}/.test(metadata) || Number(metadata.slice(0, 2)) < 1 || !date(metadata.slice(2, 6) + '-' + metadata.slice(6, 8) + '-' + metadata.slice(8, 10)) || metadata[12] !== 'J') throw invalid('metadata');
  const licenseeType = ({ C: 'COMPANY', P: 'INDIVIDUAL', F: 'INDIVIDUAL', E: 'STUDENT', L: 'CLASSROOM' } as const)[metadata[10] as 'C'] ?? 'UNKNOWN';
  const licensePack = ({ A: 'ALL_PRODUCTS_PACK', D: 'DOTULTIMATE', S: 'STUDENT' } as const)[metadata[20] as 'A'] ?? 'NONE';
  if (!Array.isArray(payload.products) || payload.products.length > 256) throw invalid('product');
  const products = payload.products.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item) && (item as Record<string, unknown>).code === code);
  if (products.length !== 1) throw invalid('product');
  const expiresOn = products[0].paidUpTo === undefined ? undefined : date(products[0].paidUpTo);
  if (products[0].paidUpTo !== undefined && !expiresOn) throw invalid('product');
  return { id: parts[0], kind: payload.hash.startsWith('TRIAL:') ? 'TRIAL' : payload.hash.startsWith('FREE:') ? 'FREE' : 'STANDARD', licenseeType, licensePack, ...(expiresOn ? { expiresOn } : {}), productCode: code };
}
/** Explicit main-only key construction supports independent public-SDK wire
 * vectors and future key rotation. Production callers use the fixed wrapper. */
export function createLicenseAssetDecoder(key: { modulus: bigint; exponent: bigint }): (data: string) => JetBrainsLicenseReceipt {
  if (typeof key.modulus !== 'bigint' || key.modulus < 3n || key.modulus.toString(2).length !== 512 || typeof key.exponent !== 'bigint' || key.exponent < 1n || key.exponent > 0xffffffffn) throw invalid('input');
  return data => {
    try {
      if (typeof data !== 'string' || !data || data.length > MAX_ASSET || data.length % 130 || !/^[0-9A-F]+$/.test(data)) throw invalid('input');
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < data.length; offset += 130) {
        const encoded = BigInt('0x' + data.slice(offset, offset + 130)); if (encoded >= key.modulus) throw invalid('block');
        let hex = pow(encoded, key.exponent, key.modulus).toString(16); if (hex.length % 2) hex = '0' + hex;
        // Official Z takes the last min(length, bitLength(n)/8-1) bytes.
        chunks.push(Buffer.from(hex, 'hex').subarray(-63));
      }
      let xml: string; try { xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw invalid('utf8'); }
      return documentReceipt(xml);
    } catch (error) { throw error instanceof JetBrainsLicenseCodecError ? error : invalid('block'); }
  };
}
export const decodeLicenseAsset = createLicenseAssetDecoder({ modulus: PUBLIC_MODULUS, exponent: 65537n });
