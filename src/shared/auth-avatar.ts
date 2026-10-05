import type { AuthAccountKind } from './auth-types';

/** Public image origins for CSP. Authentication endpoints are never image origins. */
export const ACCOUNT_AVATAR_HOSTS = [
  'avatars.githubusercontent.com', 'github.com', 'lh3.googleusercontent.com', 'lh4.googleusercontent.com', 'lh5.googleusercontent.com', 'lh6.googleusercontent.com',
  's.gravatar.com', 'secure.gravatar.com', 'www.gravatar.com', 'cdn.auth0.com', 'pbs.twimg.com',
] as const;

const numericSize = (value: string): boolean => /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= 4096;
function parameters(url: URL, rules: Record<string, (value: string) => boolean>): boolean {
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !Object.hasOwn(rules, key) || !rules[key](value)) return false;
    seen.add(key);
  }
  return true;
}

/** Display metadata only. No signed URLs, credentials, arbitrary hosts or image
 * fetches are accepted. Both main process and renderer use the same policy.
 */
export function safeAccountAvatarUrl(kind: AuthAccountKind, value: unknown): string | undefined {
  if (!['codex', 'grok', 'copilot'].includes(kind) || typeof value !== 'string' || !value || value.length > 2048 || /[\s\x00-\x1f\x7f\\]/.test(value)) return undefined;
  let url: URL; try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash) return undefined;
  const host = url.hostname.toLowerCase();
  if (host === 'avatars.githubusercontent.com') {
    if (!/^\/u\/[1-9]\d*$/.test(url.pathname) || !parameters(url, { v: value => /^\d{1,4}$/.test(value), s: numericSize, size: numericSize })) return undefined;
  } else if (host === 'github.com') {
    // GitHub's REST reference retains this public default-avatar URL.
    if (!/^\/images\/error\/[a-zA-Z0-9_-]+\.(?:png|gif)$/.test(url.pathname) || url.search) return undefined;
  } else {
    if (kind === 'copilot') return undefined;
    if (/^lh[3-6]\.googleusercontent\.com$/.test(host)) {
      if (!/^\/a(?:\/|-\/)[a-zA-Z0-9_=/.-]+$/.test(url.pathname) || !parameters(url, { sz: numericSize, s: numericSize })) return undefined;
    } else if (['s.gravatar.com', 'secure.gravatar.com', 'www.gravatar.com'].includes(host)) {
      if (!/^\/avatar\/[a-fA-F0-9]{32,64}$/.test(url.pathname) || !parameters(url, { s: numericSize, size: numericSize, r: value => ['g', 'pg', 'r', 'x'].includes(value), d: value => ['404', 'mp', 'identicon', 'monsterid', 'wavatar', 'retro', 'blank'].includes(value) })) return undefined;
    } else if (host === 'cdn.auth0.com') {
      if (!/^\/avatars\/[a-zA-Z0-9_-]+\.(?:png|jpg|jpeg|webp)$/.test(url.pathname) || url.search) return undefined;
    } else if (host === 'pbs.twimg.com' && kind === 'grok') {
      if (!/^\/profile_images\/\d+\/[a-zA-Z0-9_.-]+$/.test(url.pathname) || !parameters(url, { format: value => ['jpg', 'jpeg', 'png', 'webp'].includes(value), name: value => ['mini', 'normal', 'bigger', 'small', 'medium', 'large', 'orig'].includes(value) })) return undefined;
    } else return undefined;
  }
  return url.href;
}
