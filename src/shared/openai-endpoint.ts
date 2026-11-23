export const DEEPSEEK_OPENAI_BASE = 'https://api.deepseek.com';

export function openAiBaseUrl(value: string): string {
  const base = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(base);
    const path = url.pathname.replace(/\/+$/, '');
    if (url.origin === DEEPSEEK_OPENAI_BASE && !url.username && !url.password && !url.search && !url.hash
      && /^\/anthropic(?:\/v1)?(?:\/messages)?$/.test(path)) return DEEPSEEK_OPENAI_BASE;
    if (/(?:^|\/)anthropic(?:\/v1)?(?:\/messages)?$|\/messages$/.test(path)) return '';
  } catch { /* Other client and gateway checks validate the configured URL. */ }
  return base;
}
