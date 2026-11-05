import { describe, expect, it, vi } from 'vitest';
import { applyWaylandColorWorkaround, type WaylandColorCommandLine } from '../src/main/wayland-color';

function commandLine(initial: Record<string, string> = {}) {
  const switches = new Map(Object.entries(initial));
  const appendSwitch = vi.fn((name: string, value = '') => { switches.set(name, value); });
  const api: WaylandColorCommandLine = {
    getSwitchValue: name => switches.get(name) ?? '',
    hasSwitch: name => switches.has(name),
    appendSwitch,
  };
  return { api, switches, appendSwitch };
}

describe('Wayland 首次显示色彩兼容', () => {
  it.each([
    { XDG_SESSION_TYPE: 'wayland' },
    { WAYLAND_DISPLAY: 'wayland-0' },
  ])('从真实会话环境识别 Linux 原生 Wayland：%j', env => {
    const line = commandLine();
    expect(applyWaylandColorWorkaround(line.api, 'linux', env)).toBe(true);
    expect(line.appendSwitch.mock.calls).toEqual([['disable-features', 'WaylandWpColorManagerV1']]);
  });

  it('显式 wayland 在缺少会话环境时仍生效，完整保留既有 feature 参数', () => {
    const disabled = 'FeatureA<Trial.Group:mode/fast, FeatureB:limit/10,FeatureC';
    const enabled = 'AnotherFeature<Experiment:k/v';
    const line = commandLine({ 'ozone-platform': 'wayland', 'disable-features': disabled, 'enable-features': enabled });
    expect(applyWaylandColorWorkaround(line.api, 'linux', {})).toBe(true);
    expect(line.appendSwitch.mock.calls).toEqual([['disable-features', `${disabled},WaylandWpColorManagerV1`]]);
    expect(line.switches.get('enable-features')).toBe(enabled);
    expect(line.switches.get('ozone-platform')).toBe('wayland');
  });

  it.each(['x11', 'headless', 'drm'])('显式其他后端 %s 优先于 Wayland 环境，不做修改', backend => {
    const line = commandLine({ 'ozone-platform': backend });
    expect(applyWaylandColorWorkaround(line.api, 'linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' })).toBe(false);
    expect(line.appendSwitch).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32', 'freebsd'])('其他平台 %s 不做修改', platform => {
    const line = commandLine({ 'ozone-platform': 'wayland' });
    expect(applyWaylandColorWorkaround(line.api, platform, { XDG_SESSION_TYPE: 'wayland' })).toBe(false);
    expect(line.appendSwitch).not.toHaveBeenCalled();
  });

  it('无 Wayland 现场依据的 Linux 会话不做修改', () => {
    const line = commandLine();
    expect(applyWaylandColorWorkaround(line.api, 'linux', { XDG_SESSION_TYPE: 'x11' })).toBe(false);
    expect(line.appendSwitch).not.toHaveBeenCalled();
  });

  it('显式无值 headless 也不会触发兼容开关', () => {
    const line = commandLine({ headless: '', 'ozone-platform': 'wayland' });
    expect(applyWaylandColorWorkaround(line.api, 'linux', {})).toBe(false);
    expect(line.appendSwitch).not.toHaveBeenCalled();
  });

  it('简化命令行适配器仍能识别带值的 headless', () => {
    const line = commandLine({ headless: 'new', 'ozone-platform': 'wayland' });
    const { hasSwitch: _hasSwitch, ...withoutPresence } = line.api;
    expect(applyWaylandColorWorkaround(withoutPresence, 'linux', {})).toBe(false);
    expect(line.appendSwitch).not.toHaveBeenCalled();
  });

  it.each([
    'FeatureA,WaylandWpColorManagerV1',
    'WaylandWpColorManagerV1<Trial.Group:foo/bar,FeatureB',
    '*WaylandWpColorManagerV1:foo/bar',
  ])('已禁用时不重复追加或改写原值：%s', disabled => {
    const line = commandLine({ 'disable-features': disabled, 'ozone-platform': 'wayland' });
    expect(applyWaylandColorWorkaround(line.api, 'linux', {})).toBe(false);
    expect(line.switches.get('disable-features')).toBe(disabled);
    expect(line.appendSwitch).not.toHaveBeenCalled();
  });

  it('重复应用保持幂等，且保留原始列表末尾逗号', () => {
    const line = commandLine({ 'disable-features': 'FeatureA,', 'ozone-platform': 'wayland' });
    expect(applyWaylandColorWorkaround(line.api, 'linux', {})).toBe(true);
    expect(applyWaylandColorWorkaround(line.api, 'linux', {})).toBe(false);
    expect(line.appendSwitch.mock.calls).toEqual([['disable-features', 'FeatureA,WaylandWpColorManagerV1']]);
  });

  it.each(['WaylandWpColorManagerV1', 'FeatureA,WaylandWpColorManagerV1<Trial.Group:foo/bar'])('尊重用户对该 feature 的显式启用：%s', enabled => {
    const line = commandLine({ 'enable-features': enabled, 'disable-features': 'OtherFeature', 'ozone-platform': 'wayland' });
    expect(applyWaylandColorWorkaround(line.api, 'linux', {})).toBe(false);
    expect(line.appendSwitch).not.toHaveBeenCalled();
    expect(line.switches.get('disable-features')).toBe('OtherFeature');
  });

  it('相似 feature 名不被误判，自动后端按 Wayland 会话处理', () => {
    const line = commandLine({ 'enable-features': 'WaylandWpColorManagerV1Extra', 'disable-features': 'MyWaylandWpColorManagerV1', 'ozone-platform': 'auto' });
    expect(applyWaylandColorWorkaround(line.api, 'linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
    expect(line.appendSwitch.mock.calls).toEqual([['disable-features', 'MyWaylandWpColorManagerV1,WaylandWpColorManagerV1']]);
  });
});
