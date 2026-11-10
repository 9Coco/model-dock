import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { createSmokeProfile } from './smoke-profile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
const has = flag => args.includes(flag), noBuild = has('--no-build'), noMainBuild = has('--no-main-build'), x11 = has('--x11'), wayland = has('--wayland'), hidden = has('--hidden'), ciNoSandbox = has('--ci-no-sandbox'), expectActivation = has('--expect-activation'), noProbeFocus = has('--no-probe-focus');
const themeFlag = args.find(value => value.startsWith('--theme=')), theme = themeFlag?.slice(8) ?? 'dark';
const holdFlag = args.find(value => value.startsWith('--hold-ms=')), hold = Number(holdFlag?.slice(10) ?? 0);
const experimentFlag = args.find(value => value.startsWith('--color-experiment=')), experiment = experimentFlag?.slice(19) ?? 'product';
const values = args.filter(value => !['--no-build', '--no-main-build', '--x11', '--wayland', '--hidden', '--ci-no-sandbox', '--expect-activation', '--no-probe-focus'].includes(value) && value !== themeFlag && value !== holdFlag && value !== experimentFlag);
if (values.length > 1 || values.some(value => value.startsWith('--') || value.split(/[\\/]/).includes('..')) || !['light', 'dark', 'system'].includes(theme) || !['product', 'baseline', 'disable-wayland-color', 'force-srgb'].includes(experiment) || x11 && wayland || !Number.isInteger(hold) || hold < 0 || hold > 30_000) throw new Error('Usage: node scripts/smoke-window-presentation.mjs [work/output] [--no-build] [--no-main-build] [--x11|--wayland] [--hidden] [--theme=light|dark|system] [--hold-ms=0..30000] [--no-probe-focus] [--color-experiment=product|baseline|disable-wayland-color|force-srgb] [--ci-no-sandbox]');
if (ciNoSandbox && (process.platform !== 'linux' || process.env.CI !== 'true')) throw new Error('--ci-no-sandbox requires an explicit Linux CI QA run.');
if ((x11 || wayland || !['baseline', 'product'].includes(experiment)) && process.platform !== 'linux') throw new Error('Display-backend and color experiments are available only on Linux.');
if (!noBuild) execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (!noMainBuild) execFileSync(process.execPath, [join(root, 'scripts/build-main.mjs'), '--smoke'], { cwd: root, stdio: 'inherit' });
const profile = await createSmokeProfile(resolve(values[0] || 'work/window-presentation'));
const env = { ...process.env, MODELDOCK_SMOKE: profile.outputDir, MODELDOCK_DATA_DIR: profile.dataDir, MODELDOCK_SMOKE_NONCE: profile.nonce,
  MODELDOCK_SMOKE_AUTH_MOCK: '1', MODELDOCK_SMOKE_WINDOW_COLOR_EXPERIMENT: experiment, MODELDOCK_SMOKE_WINDOW_PRESENTATION_ONLY: '1', MODELDOCK_SMOKE_WINDOW_THEME: theme, MODELDOCK_SMOKE_WINDOW_HIDDEN: hidden ? '1' : '0', MODELDOCK_SMOKE_WINDOW_HOLD_MS: String(hold), MODELDOCK_SMOKE_WINDOW_EXPECT_ACTIVATION: expectActivation ? '1' : '0', MODELDOCK_SMOKE_WINDOW_READBACK_DELAY_MS: '2500', MODELDOCK_SMOKE_WINDOW_NO_PROBE_FOCUS: noProbeFocus ? '1' : '0' };
delete env.ELECTRON_RUN_AS_NODE; delete env.MODELDOCK_DEV_URL;
const errorPath = join(profile.outputDir, 'electron-smoke-error.txt'); if (existsSync(errorPath)) unlinkSync(errorPath);
const validationPath = join(profile.outputDir, 'window-presentation-validation.json'); if (existsSync(validationPath)) unlinkSync(validationPath);
const shownPath = join(profile.outputDir, 'window-presentation-shown.json'); if (existsSync(shownPath)) unlinkSync(shownPath);
const colorFlags = experiment === 'disable-wayland-color' ? ['--disable-features=WaylandWpColorManagerV1'] : experiment === 'force-srgb' ? ['--force-color-profile=srgb'] : [];
const childArgs = [...(x11 ? ['--ozone-platform=x11'] : wayland ? ['--ozone-platform=wayland'] : []), ...colorFlags, ...(ciNoSandbox ? ['--no-sandbox'] : []), join(root, 'work/smoke-runtime')];
const child = spawn(electron, childArgs, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
console.log(JSON.stringify({ startupProbePid: child.pid, mode: hidden ? 'hidden' : 'visible', theme, backend: x11 ? 'x11' : wayland ? 'wayland' : 'default', experiment, colorFlags, output: profile.outputDir }));
let stdout = '', stderr = '';
child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
const timeout = setTimeout(() => { child.kill(); }, 25_000 + hold);
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); }); clearTimeout(timeout);
writeFileSync(join(profile.outputDir, 'window-presentation-stdout.log'), stdout); writeFileSync(join(profile.outputDir, 'window-presentation-stderr.log'), stderr);
if (existsSync(errorPath)) throw new Error(readFileSync(errorPath, 'utf8'));
assert.equal(code, 0, 'The isolated startup probe exits normally');
const result = JSON.parse(readFileSync(validationPath, 'utf8'));
assert.equal(result.ok, true); assert.equal(result.mode, hidden ? 'hidden' : 'visible'); assert.equal(result.mainPid, child.pid);
assert.equal(result.samples.length, hidden || noProbeFocus ? 4 : 5); assert.equal(result.explicitProbeFocusCalls, hidden || noProbeFocus ? 0 : 1);
assert.ok(result.samples.every(value => value.elapsedMs >= 2500), 'No renderer readback occurs in the first 2500ms');
if (hidden) {
  const navigation = JSON.parse(readFileSync(join(profile.outputDir, 'tray-navigation-validation.json'), 'utf8'));
  assert.equal(navigation.ok, true);
  assert.equal(navigation.firstRevealPage, 'network');
  assert.deepEqual(navigation.laterReveals.map(item => item.page), ['settings', 'tools', 'providers']);
}
console.log(JSON.stringify({ startupProbePid: child.pid, mode: result.mode, samples: result.samples.map(value => ({ stage: value.stage, elapsedMs: value.elapsedMs, nativeFocused: value.nativeFocused, documentFocused: value.dom.focused, visible: value.visible, theme: value.dom.theme, anchor: value.pixels.anchorRgb, cssBackground: value.dom.anchor?.expectedBackground })), comparison: result.comparison, output: profile.outputDir }));
