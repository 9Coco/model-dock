/** Normalize recognized pasted wrappers, never guess or reveal credential content. */
export function normalizeApiKey(value: string): string {
  if (typeof value !== 'string') throw new Error('API Key 必须是文本。');
  let key = value.trim();
  const unwrap = () => {
    if (key.length >= 2 && ((key[0] === '"' && key.at(-1) === '"') || (key[0] === "'" && key.at(-1) === "'"))) key = key.slice(1, -1).trim();
  };
  unwrap();
  key = key.replace(/^(?:Authorization\s*:\s*)?Bearer\s+/i, '').trim();
  unwrap();
  if (/[\s\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u206f\uFEFF]/.test(key)) throw new Error('API Key 内含空白或不可见字符，请从供应商控制台重新复制完整密钥。');
  return key;
}
