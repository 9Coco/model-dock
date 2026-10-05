import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type RuntimeMode = 'production' | 'development' | 'smoke';
declare global { const __MODELDOCK_RUNTIME_MODE__: RuntimeMode; const __MODELDOCK_SMOKE_BUILD__: boolean; }
export const SMOKE_PROFILE_MARKER = 'modeldock-smoke-profile.json';
export interface VerifiedSmokeProfile { outputDir: string; dataDir: string; markerPath: string; nonce: string }
export interface RuntimeConfig { mode: RuntimeMode; dataDir?: string; devUrl?: string; smoke?: VerifiedSmokeProfile }
type Environment = Record<string, string | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const fixtureFiles = ['modeldock.sqlite', 'vault.key'];
const failure = () => new Error('Smoke 运行必须由验证脚本创建全新、无链接的隔离资料目录。');

/** Validate paths before opening the marker, database, vault or Electron profile. */
function canonicalDirectory(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.split(/[\\/]/).some(part => part === '.' || part === '..')) throw failure();
  const absolute = resolve(value);
  for (let current = absolute; ; current = dirname(current)) {
    if (!existsSync(current)) throw failure();
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure();
    if (dirname(current) === current) break;
  }
  const canonical = realpathSync(absolute);
  if (relative(canonical, absolute) !== '') throw failure();
  return canonical;
}
function plain(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export function verifySmokeProfile(env: Environment, options: { parentPid?: number; now?: number } = {}): VerifiedSmokeProfile {
  try {
    const outputDir = canonicalDirectory(env.MODELDOCK_SMOKE), dataDir = canonicalDirectory(env.MODELDOCK_DATA_DIR);
    if (!UUID.test(basename(dataDir)) || dirname(dataDir) !== join(outputDir, 'data')) throw failure();
    const nonce = env.MODELDOCK_SMOKE_NONCE;
    if (!nonce || !HEX.test(nonce)) throw failure();
    const markerPath = join(dataDir, SMOKE_PROFILE_MARKER), markerInfo = lstatSync(markerPath);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1 || markerInfo.size > 16 * 1024) throw failure();
    const marker = plain(JSON.parse(readFileSync(markerPath, 'utf8')));
    const markerNonce = marker.nonce;
    if (typeof markerNonce !== 'string' || !HEX.test(markerNonce) || !timingSafeEqual(Buffer.from(nonce), Buffer.from(markerNonce))) throw failure();
    const createdAt = typeof marker.createdAt === 'string' ? Date.parse(marker.createdAt) : NaN, now = options.now ?? Date.now();
    if (marker.version !== 1 || marker.fixture !== 'modeldock-provider-duplicates-v1' || !Number.isSafeInteger(marker.runnerPid) || Number(marker.runnerPid) < 1 || marker.runnerPid !== (options.parentPid ?? process.ppid)
      || marker.outputDir !== outputDir || marker.dataDir !== dataDir || !Number.isFinite(createdAt) || createdAt > now + 60_000 || now - createdAt > 30 * 60_000) throw failure();
    // A browser profile or previous smoke run is never a fresh fixture, even if
    // someone reuses its marker. Check the directory before reading file bytes.
    const expected = [...fixtureFiles, SMOKE_PROFILE_MARKER].sort();
    if (JSON.stringify(readdirSync(dataDir).sort()) !== JSON.stringify(expected)) throw failure();
    const files = plain(marker.files);
    if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify(fixtureFiles.slice().sort())) throw failure();
    for (const name of fixtureFiles) {
      const filename = join(dataDir, name), info = lstatSync(filename), spec = plain(files[name]);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== spec.size || info.size < 1 || info.size > 2 * 1024 * 1024
        || name === 'vault.key' && info.size !== 32 || typeof spec.sha256 !== 'string' || !HEX.test(spec.sha256)) throw failure();
      if (createHash('sha256').update(readFileSync(filename)).digest('hex') !== spec.sha256) throw failure();
    }
    return { outputDir, dataDir, markerPath, nonce };
  } catch { throw failure(); }
}

/** Build-time mode is supplied by esbuild, never selected by an environment flag. */
export function resolveRuntimeConfig(mode: RuntimeMode, env: Environment = process.env, options: { parentPid?: number; now?: number } = {}): RuntimeConfig {
  if (!['production', 'development', 'smoke'].includes(mode)) throw new Error('运行模式无效。');
  if (mode !== 'smoke') for (const key of Object.keys(env)) if (key.startsWith('MODELDOCK_SMOKE')) delete env[key];
  let dataDir: string | undefined;
  if (mode !== 'smoke' && env.MODELDOCK_DATA_DIR !== undefined) {
    const value = env.MODELDOCK_DATA_DIR;
    if (!value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('资料目录覆盖必须是有效的绝对路径。');
    dataDir = resolve(value);
  }
  if (mode === 'production') { delete env.MODELDOCK_DEV_URL; return { mode, dataDir }; }
  if (mode === 'development') {
    let url: URL;
    try { url = new URL(env.MODELDOCK_DEV_URL ?? ''); } catch { throw new Error('开发界面必须由 npm run dev 启动。'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.hash || url.search) throw new Error('开发界面只允许本机 HTTP 地址。');
    return { mode, dataDir, devUrl: url.href };
  }
  delete env.MODELDOCK_DEV_URL;
  const smoke = verifySmokeProfile(env, options);
  return { mode, dataDir: smoke.dataDir, smoke };
}
