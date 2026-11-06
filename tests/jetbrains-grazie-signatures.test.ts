import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JetBrainsGrazieSignatures, jetBrainsGrazieTextDigest } from '../src/main/jetbrains-grazie-signatures';

const scope = 'account-token-digest:exact-profile-id';
const tool = { id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' };
const remember = (cache: JetBrainsGrazieSignatures, text: string, signature = 'opaque-signature') => cache.rememberText(scope, jetBrainsGrazieTextDigest(text), signature);

describe('main-only bounded JetBrains Grazie opaque signatures', () => {
  it('uses the same SHA-256 UTF-8 digest as incremental native text without retaining plaintext', () => {
    const text = 'private assistant 中文🙂 answer', incremental = createHash('sha256').update('private assistant 中文', 'utf8').update('🙂 answer', 'utf8').digest('hex');
    expect(jetBrainsGrazieTextDigest(text)).toBe(incremental);
    const cache = new JetBrainsGrazieSignatures(); remember(cache, text);
    expect(cache.lookupText(scope, text)).toBe('opaque-signature'); expect(cache.lookupText(scope, text + ' ')).toBeUndefined();
    expect(JSON.stringify(cache)).not.toContain(text);
  });
  it('isolates every account/token revision, native model, text and tool identity', () => {
    const cache = new JetBrainsGrazieSignatures(); remember(cache, 'answer', 'text-signature'); cache.rememberTool(scope, tool, 'tool-signature');
    for (const other of ['other-account:exact-profile-id', 'account-token-digest:other-profile-id']) {
      expect(cache.lookupText(other, 'answer')).toBeUndefined(); expect(cache.lookupTool(other, tool)).toBeUndefined();
    }
    expect(cache.lookupTool(scope, tool)).toBe('tool-signature'); expect(cache.lookupText(scope, tool.arguments)).toBeUndefined();
    for (const changed of [{ ...tool, id: 'call-2' }, { ...tool, name: 'other' }, { ...tool, arguments: '{ "q": "x" }' }]) expect(cache.lookupTool(scope, changed)).toBeUndefined();
    expect(JSON.stringify(cache)).not.toContain(tool.arguments);
  });
  it('frames fields before hashing instead of joining ambiguous identity strings', () => {
    const cache = new JetBrainsGrazieSignatures(), one = { id: 'a:b', name: 'c', arguments: '{}' }, two = { id: 'a', name: 'b:c', arguments: '{}' };
    cache.rememberTool(scope, one, 'one'); cache.rememberTool(scope, two, 'two');
    expect(cache.lookupTool(scope, one)).toBe('one'); expect(cache.lookupTool(scope, two)).toBe('two');
  });
  it('fails closed on conflicting signatures for identical visible text or tool calls', () => {
    const cache = new JetBrainsGrazieSignatures(); remember(cache, 'OK', 'one'); remember(cache, 'OK', 'two'); remember(cache, 'OK', 'one');
    expect(cache.lookupText(scope, 'OK')).toBeUndefined();
    cache.rememberTool(scope, tool, 'one'); cache.rememberTool(scope, tool, 'two');
    expect(cache.lookupTool(scope, tool)).toBeUndefined(); expect(cache.stats().entries).toBe(2);
  });
  it('distinguishes verified native unsigned tools from missing, mismatched and evicted history', () => {
    const cache = new JetBrainsGrazieSignatures({ maxEntries: 1 });
    expect(cache.lookupToolRecord(scope, tool)).toBeUndefined();
    cache.rememberTool(scope, tool); cache.rememberTool(scope, tool);
    expect(cache.lookupToolRecord(scope, tool)).toEqual({});
    expect(cache.lookupTool(scope, tool)).toBeUndefined();
    expect(cache.lookupToolRecord(scope, { ...tool, arguments: '{"q":"changed"}' })).toBeUndefined();
    expect(cache.lookupToolRecord('other-profile', tool)).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 1, bytes: 128 });
    cache.rememberTool(scope, { ...tool, id: 'new-call' }, 'signed');
    expect(cache.lookupToolRecord(scope, tool)).toBeUndefined();
    expect(cache.lookupToolRecord(scope, { ...tool, id: 'new-call' })).toEqual({ signature: 'signed' });
  });
  it('fails closed when signed and native unsigned receipts conflict in either order', () => {
    for (const signatures of [[undefined, 'signed'], ['signed', undefined]]) {
      const cache = new JetBrainsGrazieSignatures();
      for (const signature of signatures) cache.rememberTool(scope, tool, signature);
      expect(cache.lookupToolRecord(scope, tool)).toBeUndefined();
      cache.rememberTool(scope, tool);
      expect(cache.lookupToolRecord(scope, tool)).toBeUndefined();
    }
  });
  it('expires unsigned native receipts using the same bounded TTL', () => {
    let now = 1000; const cache = new JetBrainsGrazieSignatures({ now: () => now, ttlMs: 100 });
    cache.rememberTool(scope, tool); now = 1099; expect(cache.lookupToolRecord(scope, tool)).toEqual({});
    now = 1100; expect(cache.lookupToolRecord(scope, tool)).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
  it('atomically commits signed text plus signed and native unsigned tool receipts', () => {
    const cache = new JetBrainsGrazieSignatures();
    cache.rememberBatch(scope, { text: { digest: jetBrainsGrazieTextDigest('answer'), signature: 'text' }, tools: [
      { tool, signature: 'tool' }, { tool: { ...tool, id: 'unsigned' } },
    ] });
    expect(cache.lookupText(scope, 'answer')).toBe('text');
    expect(cache.lookupToolRecord(scope, tool)).toEqual({ signature: 'tool' });
    expect(cache.lookupToolRecord(scope, { ...tool, id: 'unsigned' })).toEqual({});
    expect(cache.stats().entries).toBe(3);
  });
  it('leaves all existing receipts intact when a later batch entry fails validation', () => {
    const cache = new JetBrainsGrazieSignatures({ maxSignatureBytes: 4, maxEntries: 2 });
    remember(cache, 'kept', 'safe'); cache.rememberTool(scope, tool, 'safe');
    const before = cache.stats();
    expect(() => cache.rememberBatch(scope, { tools: [
      { tool: { ...tool, id: 'new' }, signature: 'good' }, { tool, signature: 'too-long' },
    ] })).toThrow(/签名/);
    expect(cache.stats()).toEqual(before);
    expect(cache.lookupToolRecord(scope, { ...tool, id: 'new' })).toBeUndefined();
    // Neither overwritten signatures nor partial eviction may survive refusal.
    expect(cache.lookupToolRecord(scope, tool)).toEqual({ signature: 'safe' });
    expect(cache.lookupText(scope, 'kept')).toBe('safe');
  });
  it('bounds the entire staged transaction before writing any receipts', () => {
    for (const options of [{ maxEntries: 1 }, { maxBytes: 260 }]) {
      const cache = new JetBrainsGrazieSignatures(options); cache.rememberTool('other', tool);
      const before = cache.stats();
      expect(() => cache.rememberBatch(scope, { tools: [
        { tool, signature: 'four' }, { tool: { ...tool, id: 'second' }, signature: 'four' },
      ] })).toThrow(/签名/);
      expect(cache.stats()).toEqual(before); expect(cache.lookupToolRecord('other', tool)).toEqual({});
      expect(cache.lookupToolRecord(scope, tool)).toBeUndefined();
    }
  });
  it('validates a batch clock before any cache mutation', () => {
    let now = 1000; const cache = new JetBrainsGrazieSignatures({ now: () => now });
    cache.rememberTool(scope, tool, 'before'); now = NaN;
    expect(() => cache.rememberBatch(scope, { tools: [{ tool, signature: 'after' }] })).toThrow(/签名/);
    now = 1001; expect(cache.lookupToolRecord(scope, tool)).toEqual({ signature: 'before' });
  });
  it('uses a fixed TTL from commit and does not keep a conversation alive through reads', () => {
    let now = 1000; const cache = new JetBrainsGrazieSignatures({ now: () => now, ttlMs: 100 });
    remember(cache, 'old'); now = 1099; expect(cache.lookupText(scope, 'old')).toBe('opaque-signature');
    now = 1100; expect(cache.lookupText(scope, 'old')).toBeUndefined(); expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
  it('enforces total entry and UTF-8 signature byte bounds with LRU eviction', () => {
    const entries = new JetBrainsGrazieSignatures({ maxEntries: 2 }); remember(entries, 'a'); remember(entries, 'b'); entries.lookupText(scope, 'a'); remember(entries, 'c');
    expect(entries.lookupText(scope, 'a')).toBe('opaque-signature'); expect(entries.lookupText(scope, 'b')).toBeUndefined(); expect(entries.stats().entries).toBe(2);
    const bytes = new JetBrainsGrazieSignatures({ maxBytes: 132, maxSignatureBytes: 4 }); remember(bytes, 'a', '🙂');
    expect(bytes.stats()).toEqual({ entries: 1, bytes: 132 }); expect(() => remember(bytes, 'bad', '🙂x')).toThrow(/签名/);
    remember(bytes, 'b', 'four'); expect(bytes.lookupText(scope, 'a')).toBeUndefined(); expect(bytes.stats().bytes).toBeLessThanOrEqual(132);
  });
  it('clears one native namespace without affecting another, then clears all on shutdown', () => {
    const cache = new JetBrainsGrazieSignatures(); remember(cache, 'answer'); cache.rememberTool(scope, tool, 'one'); cache.rememberTool('other', tool, 'two');
    cache.clearNamespace(scope); expect(cache.lookupText(scope, 'answer')).toBeUndefined(); expect(cache.lookupTool(scope, tool)).toBeUndefined(); expect(cache.lookupTool('other', tool)).toBe('two');
    cache.clear(); expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
  it('rejects unbounded or invalid cache material without echoing history or signature values', () => {
    const cache = new JetBrainsGrazieSignatures({ maxSignatureBytes: 4 }); remember(cache, 'kept', 'safe');
    for (const action of [() => remember(cache, 'PRIVATE_HISTORY', 'PRIVATE_SIGNATURE'), () => cache.rememberText(scope, 'PRIVATE_HISTORY', 'safe'), () => cache.rememberTool(scope, { ...tool, id: 'PRIVATE\nIDENTITY' }, 'safe')]) {
      try { action(); throw new Error('Expected a bounded-cache refusal'); } catch (error) { expect(String(error)).toContain('签名'); expect(String(error)).not.toContain('PRIVATE'); }
    }
    expect(cache.lookupText(scope, 'kept')).toBe('safe');
    expect(() => new JetBrainsGrazieSignatures({ maxEntries: Infinity })).toThrow(); expect(() => new JetBrainsGrazieSignatures({ maxBytes: 1 })).toThrow();
  });
});
