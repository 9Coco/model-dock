import { createHash } from 'node:crypto';

export interface JetBrainsGrazieToolIdentity { id: string; name: string; arguments: string }
export interface JetBrainsGrazieToolRecord { signature?: string }
export interface JetBrainsGrazieSignatureBatch {
  text?: { digest: string; signature: string };
  tools: Array<{ tool: JetBrainsGrazieToolIdentity; signature?: string }>;
}
export interface JetBrainsGrazieSignatureOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxSignatureBytes?: number;
}
interface Entry { namespace: string; signature?: string; ambiguous: boolean; expiresAt: number; bytes: number }
interface PendingEntry { key: string; signature?: string; bytes: number }
const HARD_BYTES = 64 * 1024 * 1024;
const KEY_BYTES = 128; // Two SHA-256 hex strings: entry key and namespace.
const invalid = () => new Error('JetBrains 原生思考签名超出支持范围或格式无效。');
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
function bounded(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw invalid();
  return result;
}
function sized(value: unknown, maximum: number, identifier = false): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum
    && (!identifier || !/[\x00-\x1f\x7f]/.test(value));
}

/** Equal to incremental createHash('sha256').update(delta, 'utf8').digest('hex'). */
export function jetBrainsGrazieTextDigest(text: string): string {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 32 * 1024 * 1024) throw invalid();
  return digest(text);
}

/** Main-process opaque metadata only. No prompts, text, tool arguments, account
 * credentials, disk persistence or public serialization belong in this cache.
 * The bridge commits entries only after successful terminal + EOF validation.
 * Callers scope namespace to the exact account session, native profile and
 * canonical history-prefix hash. Clearing a namespace clears only that prefix.
 */
export class JetBrainsGrazieSignatures {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maximumEntries: number;
  private readonly maximumBytes: number;
  private readonly maximumSignatureBytes: number;

  constructor(options: JetBrainsGrazieSignatureOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttl = bounded(options.ttlMs, 30 * 60_000, 24 * 60 * 60_000);
    this.maximumEntries = bounded(options.maxEntries, 256, 4096);
    this.maximumBytes = bounded(options.maxBytes, 4 * 1024 * 1024, HARD_BYTES, KEY_BYTES);
    this.maximumSignatureBytes = bounded(options.maxSignatureBytes, 256 * 1024, 1024 * 1024);
  }
  private namespace(value: string): string {
    if (!sized(value, 2048, true)) throw invalid();
    return digest(value);
  }
  private textKey(namespace: string, textDigest: string): string {
    if (typeof textDigest !== 'string' || !/^[a-f0-9]{64}$/.test(textDigest)) throw invalid();
    return digest(JSON.stringify([namespace, 'text', textDigest]));
  }
  private toolKey(namespace: string, tool: JetBrainsGrazieToolIdentity): string {
    if (!tool || !sized(tool.id, 512, true) || !sized(tool.name, 512, true)
      || typeof tool.arguments !== 'string' || Buffer.byteLength(tool.arguments, 'utf8') > 2 * 1024 * 1024) throw invalid();
    // Framed fields avoid collisions such as id='a:b', name='c' vs id='a', name='b:c'.
    return digest(JSON.stringify([namespace, 'tool', tool.id, tool.name, tool.arguments]));
  }
  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
  private prune(now: number): void {
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - this.ttl) throw invalid();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.remove(key);
  }
  private stage(key: string, signature?: string): PendingEntry {
    if (signature !== undefined && !sized(signature, this.maximumSignatureBytes)) throw invalid();
    const bytes = KEY_BYTES + (signature === undefined ? 0 : Buffer.byteLength(signature, 'utf8'));
    if (bytes > this.maximumBytes) throw invalid();
    return { key, ...(signature === undefined ? {} : { signature }), bytes };
  }
  private commit(namespace: string, pending: PendingEntry[]): void {
    // Validate the clock before expiry cleanup or any receipt changes. All input
    // validation/hashing is already complete, so no later input can half-commit.
    const now = this.now(); this.prune(now);
    for (const { key, signature, bytes } of pending) {
      const previous = this.entries.get(key);
      // Identical visible output can have different hidden reasoning. An ambiguous
      // key must never silently select one conversation's signature for another.
      const ambiguous = !!previous && (previous.ambiguous || previous.signature !== signature);
      this.remove(key);
      const entry: Entry = { namespace, ...(ambiguous || signature === undefined ? {} : { signature }), ambiguous, expiresAt: now + this.ttl, bytes: ambiguous ? KEY_BYTES : bytes };
      this.entries.set(key, entry); this.bytes += entry.bytes;
    }
    while (this.entries.size > this.maximumEntries || this.bytes > this.maximumBytes) this.remove(this.entries.keys().next().value!);
  }
  private lookup(key: string): JetBrainsGrazieToolRecord | undefined {
    this.prune(this.now());
    const entry = this.entries.get(key);
    if (!entry) return;
    // LRU access order changes; reads do not prolong signature lifetime.
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.ambiguous ? undefined : (entry.signature === undefined ? {} : { signature: entry.signature });
  }
  rememberText(namespace: string, textDigest: string, signature: string): void {
    if (!sized(signature, this.maximumSignatureBytes)) throw invalid();
    const scope = this.namespace(namespace); this.commit(scope, [this.stage(this.textKey(scope, textDigest), signature)]);
  }
  lookupText(namespace: string, text: string): string | undefined {
    const scope = this.namespace(namespace); return this.lookup(this.textKey(scope, jetBrainsGrazieTextDigest(text)))?.signature;
  }
  // Undefined is a verified native unsigned tool call, never a cache miss.
  // The bridge records all tool calls only after successful terminal + EOF.
  rememberTool(namespace: string, tool: JetBrainsGrazieToolIdentity, signature?: string): void {
    const scope = this.namespace(namespace); this.commit(scope, [this.stage(this.toolKey(scope, tool), signature)]);
  }
  rememberBatch(namespace: string, batch: JetBrainsGrazieSignatureBatch): void {
    const scope = this.namespace(namespace);
    if (!batch || !Array.isArray(batch.tools) || batch.tools.length > this.maximumEntries) throw invalid();
    const pending: PendingEntry[] = [];
    if (batch.text !== undefined) {
      if (!batch.text || !sized(batch.text.signature, this.maximumSignatureBytes)) throw invalid();
      pending.push(this.stage(this.textKey(scope, batch.text.digest), batch.text.signature));
    }
    if (pending.length + batch.tools.length > this.maximumEntries) throw invalid();
    let bytes = pending.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of batch.tools) {
      if (!entry) throw invalid();
      const staged = this.stage(this.toolKey(scope, entry.tool), entry.signature);
      bytes += staged.bytes;
      if (bytes > this.maximumBytes) throw invalid();
      pending.push(staged);
    }
    // Pending entries retain only hashes and bounded opaque signatures; no tool
    // identity or request is copied into the transaction or persisted cache.
    if (pending.length) this.commit(scope, pending);
  }
  lookupTool(namespace: string, tool: JetBrainsGrazieToolIdentity): string | undefined {
    return this.lookupToolRecord(namespace, tool)?.signature;
  }
  lookupToolRecord(namespace: string, tool: JetBrainsGrazieToolIdentity): JetBrainsGrazieToolRecord | undefined {
    const scope = this.namespace(namespace); return this.lookup(this.toolKey(scope, tool));
  }
  clearNamespace(namespace: string): void {
    const scope = this.namespace(namespace);
    for (const [key, entry] of this.entries) if (entry.namespace === scope) this.remove(key);
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  stats(): { entries: number; bytes: number } { this.prune(this.now()); return { entries: this.entries.size, bytes: this.bytes }; }
}
