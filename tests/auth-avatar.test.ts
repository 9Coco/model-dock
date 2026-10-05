import { describe, expect, it } from 'vitest';
import { safeAccountAvatarUrl } from '../src/shared/auth-avatar';

describe('public account avatar metadata policy', () => {
  it('accepts known public avatar paths with only display parameters', () => {
    expect(safeAccountAvatarUrl('copilot', 'https://avatars.githubusercontent.com/u/42?v=4&s=96')).toBe('https://avatars.githubusercontent.com/u/42?v=4&s=96');
    expect(safeAccountAvatarUrl('codex', 'https://lh3.googleusercontent.com/a/PROFILE=s96-c')).toBeDefined();
    expect(safeAccountAvatarUrl('codex', 'https://cdn.auth0.com/avatars/cc.png')).toBeDefined();
    expect(safeAccountAvatarUrl('codex', 'https://s.gravatar.com/avatar/0123456789abcdef0123456789abcdef?s=96&d=identicon')).toBeDefined();
    expect(safeAccountAvatarUrl('grok', 'https://pbs.twimg.com/profile_images/123456/photo_normal.jpg?name=small&format=jpg')).toBeDefined();
    expect(safeAccountAvatarUrl('copilot', 'https://github.com/images/error/octocat_happy.gif')).toBeDefined();
  });
  it('rejects credentials, arbitrary hosts, schemes, ports, fragments and signed queries', () => {
    for (const url of [
      'http://avatars.githubusercontent.com/u/42', 'data:image/png;base64,AAAA', 'file:///C:/secret.png', 'javascript:alert(1)',
      'https://evil.example/avatar.png', 'https://avatars.githubusercontent.com.evil.example/u/42', 'https://avatars.githubusercontent.com@evil.example/u/42',
      'https://user:password@avatars.githubusercontent.com/u/42', 'https://avatars.githubusercontent.com:8443/u/42', 'https://avatars.githubusercontent.com/u/42#private',
      'https://avatars.githubusercontent.com/u/42?access_token=PRIVATE', 'https://avatars.githubusercontent.com/u/42?t%6fken=PRIVATE', 'https://avatars.githubusercontent.com/u/42?signature=PRIVATE',
      'https://avatars.githubusercontent.com/u/42?v=4&v=5', 'https://github.com/login', 'https://github.com/images/error/octocat_happy.gif?token=PRIVATE',
      'https://s.gravatar.com/avatar/0123456789abcdef0123456789abcdef?d=https%3A%2F%2Fevil.example%2FPRIVATE',
      'https://lh3.googleusercontent.com/a/PROFILE?key=PRIVATE', 'https://pbs.twimg.com/profile_images/123/x.jpg?name=large&auth=PRIVATE',
      'https://avatars.githubusercontent.com/u/42\n', 'https://avatars.githubusercontent.com\\u\\42',
    ]) expect(safeAccountAvatarUrl('copilot', url) ?? safeAccountAvatarUrl('codex', url) ?? safeAccountAvatarUrl('grok', url)).toBeUndefined();
  });
  it('keeps provider-specific image sources scoped and never coerces non-string values', () => {
    expect(safeAccountAvatarUrl('copilot', 'https://lh3.googleusercontent.com/a/PROFILE')).toBeUndefined();
    expect(safeAccountAvatarUrl('codex', 'https://pbs.twimg.com/profile_images/123/a.jpg')).toBeUndefined();
    for (const value of [undefined, null, {}, [], 42]) expect(safeAccountAvatarUrl('copilot', value)).toBeUndefined();
  });
});
