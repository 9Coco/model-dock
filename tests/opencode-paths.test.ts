import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openCodeConfigDirectory } from '../src/main/opencode-paths';

afterEach(() => vi.unstubAllEnvs());
describe('OpenCode global XDG paths', () => {
  it('retains the existing defaults on every supported platform', () => {
    vi.stubEnv('XDG_CONFIG_HOME', ''); vi.stubEnv('XDG_DATA_HOME', '');
    expect(openCodeConfigDirectory()).toBe(join(homedir(), '.config', 'opencode'));
  });
  it('honors the current absolute XDG config root independently', () => {
    const config = join(homedir(), 'fixture-config'), data = join(homedir(), 'fixture-data');
    vi.stubEnv('XDG_CONFIG_HOME', config); vi.stubEnv('XDG_DATA_HOME', data);
    expect(openCodeConfigDirectory()).toBe(join(config, 'opencode'));
  });
  it('keeps explicit fixture homes isolated unless a root is explicitly configured', () => {
    const home = join(homedir(), 'fixture-home'), config = join(home, 'custom-config'), data = join(home, 'custom-data', 'opencode');
    vi.stubEnv('XDG_CONFIG_HOME', join(homedir(), 'live-config')); vi.stubEnv('XDG_DATA_HOME', join(homedir(), 'live-data'));
    expect(openCodeConfigDirectory(home)).toBe(join(home, '.config', 'opencode'));
    expect(openCodeConfigDirectory(home, config)).toBe(join(config, 'opencode'));
  });
  it('ignores relative XDG roots rather than choosing a working-directory-dependent client profile', () => {
    vi.stubEnv('XDG_CONFIG_HOME', 'relative/config'); vi.stubEnv('XDG_DATA_HOME', 'relative/data');
    expect(openCodeConfigDirectory()).toBe(join(homedir(), '.config', 'opencode'));
  });
});
