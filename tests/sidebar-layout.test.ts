import { expect, it } from 'vitest';
import { SIDEBAR_DEFAULT_WIDTH, sidebarMaximum, sidebarWidth, storedSidebarWidth } from '../src/shared/sidebar-layout';

it('keeps 620 pixels for the main view while allowing a bounded wider sidebar', () => {
  expect(sidebarMaximum(980)).toBe(360);
  expect(sidebarMaximum(1320)).toBe(420);
  expect(sidebarMaximum(760)).toBe(200);
  expect(sidebarWidth(400, 980)).toBe(360);
  expect(sidebarWidth(400, 1320)).toBe(400);
});
it('rejects corrupt persisted widths and retains valid preferences independently of the viewport', () => {
  for (const value of [null, '', 'NaN', 'Infinity', '100000', '-1', '199', '421', '2e2', '{}']) expect(storedSidebarWidth(value)).toBe(SIDEBAR_DEFAULT_WIDTH);
  expect(storedSidebarWidth('420')).toBe(420);
  expect(sidebarWidth(storedSidebarWidth('420'), 980)).toBe(360);
  expect(sidebarWidth(storedSidebarWidth('420'), 1320)).toBe(420);
});
it('bounds pointer and keyboard preferences even for non-finite input', () => {
  expect(sidebarWidth(-10, 1080)).toBe(200);
  expect(sidebarWidth(10000, 1080)).toBe(420);
  expect(sidebarWidth(Number.NaN, 1080)).toBe(216);
  expect(sidebarMaximum(Number.NaN)).toBe(420);
});
