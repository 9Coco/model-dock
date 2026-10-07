import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { createSmokeProfile, safeTestDirectory } from './smoke-profile.mjs';
import { verifyQaExecutable } from './smoke-package.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), noBuild = args.includes('--no-build'), values = args.filter(value => value !== '--no-build');
if (values.length > 2 || values.some(value => value.startsWith('--') || value.split(/[\\/]/).includes('..'))) throw new Error('Usage: node scripts/smoke-gateway-startup.mjs [fresh-work-output] [dedicated-QA-ModelDock.exe] [--no-build]');
if (process.platform !== 'win32') throw new Error('This native startup runner currently verifies Windows TCP listener ownership.');
const work = safeTestDirectory(join(root, 'work'), true);
const output = resolve(values[0] || join(work, 'gateway-startup-qa', randomUUID()));
const outputRelative = relative(work, output);
if (!outputRelative || outputRelative.startsWith('..') || isAbsolute(outputRelative) || existsSync(output)) throw new Error('Gateway startup QA requires a fresh output directory strictly below workspace work/.');
safeTestDirectory(output, true);
let executable = electron, applicationArgs = [join(root, 'work/smoke-runtime')];
if (values[1]) { executable = verifyQaExecutable(resolve(values[1])); applicationArgs = []; }
else {
  if (!noBuild) {
    const npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (existsSync(npmCli)) execFileSync(process.execPath, [npmCli, 'run', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true });
    else execFileSync('npm.cmd', ['run', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true, shell: true });
  }
  execFileSync(process.execPath, [join(root, 'scripts/build-main.mjs'), '--smoke'], { cwd: root, stdio: 'inherit', windowsHide: true });
}
const pause = ms => new Promise(done => setTimeout(done, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (key.startsWith('MODELDOCK_SMOKE')) delete environment[key];
delete environment.MODELDOCK_DEV_URL;
delete environment.MODELDOCK_DATA_DIR;
delete environment.ELECTRON_RUN_AS_NODE;

function ordinaryFile(filename) {
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Persisted startup fixtures must be ordinary unlinked files.');
  return info;
}
async function persistedProfile(stageOutput, previous) {
  const profile = await createSmokeProfile(stageOutput);
  if (!previous) return { profile, persistence: null };
  safeTestDirectory(previous.dataDir);
  const copiedFiles = {};
  for (const name of ['modeldock.sqlite', 'vault.key']) {
    const source = join(previous.dataDir, name), destination = join(profile.dataDir, name);
    ordinaryFile(source); ordinaryFile(destination);
    const original = readFileSync(source);
    if (original.length < 1 || original.length > 2 * 1024 * 1024 || name === 'vault.key' && original.length !== 32) throw new Error('Persisted startup fixture exceeds the smoke profile limits.');
    copyFileSync(source, destination);
    const copied = readFileSync(destination);
    assert.equal(hash(copied), hash(original), 'The next process must reopen the exact files saved by the previous process');
    copiedFiles[name] = { size: copied.length, sha256: hash(copied) };
  }
  // Never reuse a Chromium profile or weaken the fresh-profile gate. Only the
  // closed application's database and matching vault enter a new UUID fixture.
  const markerPath = join(profile.dataDir, 'modeldock-smoke-profile.json');
  ordinaryFile(markerPath);
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  writeFileSync(markerPath, JSON.stringify({ ...marker, files: copiedFiles }, null, 2));
  return { profile, persistence: { sourceDataDir: previous.dataDir, exactCopiedFiles: copiedFiles } };
}
async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
  assert.ok(port >= 1024 && port <= 65535 && port !== 18181);
  return port;
}
function listeners(port) {
  const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$ErrorActionPreference = 'Stop'
$startupSockets = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq ${port} } | Select-Object LocalAddress, LocalPort, OwningProcess)
ConvertTo-Json -InputObject $startupSockets -Compress`;
  const result = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 15_000 });
  const value = JSON.parse(result.replace(/^\uFEFF/, '').trim());
  return Array.isArray(value) ? value : [value];
}
async function noListener(port) {
  const native = listeners(port);
  assert.deepEqual(native, [], 'A disabled or closed QA application must not leave the custom port listening');
  const code = await new Promise((done, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Expected a refused connection, received a TCP timeout')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Unexpected listener on the QA custom port')); });
    socket.once('error', error => { socket.destroy(); done(error.code); });
  });
  assert.equal(code, 'ECONNREFUSED');
  return { listeners: native, tcpError: code };
}
async function http(port, occupied = false) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  const payload = await response.json();
  if (occupied) { assert.equal(response.status, 503); assert.equal(payload.fixture, 'modeldock-port-occupied'); }
  else { assert.equal(response.status, 401); assert.ok(payload.error?.message?.includes('ModelDock API Key')); }
  return { host: '127.0.0.1', port, path: '/v1/models', statusCode: response.status, modeldockAuthenticationRequired: !occupied, occupiedFixture: occupied };
}
function beforeDeadline(promise, ms, label) {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway startup QA timed out: ${label}`)), ms);
    promise.then(value => { clearTimeout(timer); done(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
const customPort = await freePort();
const stages = ['defaults', 'enabled', 'disabled', 'occupied'];
const results = [];
let previous;
for (const [index, stage] of stages.entries()) {
  const stageOutput = join(output, `${index + 1}-${stage}`);
  const { profile, persistence } = await persistedProfile(stageOutput, previous);
  let occupiedServer;
  if (stage === 'occupied') {
    occupiedServer = createServer((_request, response) => { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ fixture: 'modeldock-port-occupied' })); });
    await new Promise((done, reject) => { occupiedServer.once('error', reject); occupiedServer.listen({ host: '127.0.0.1', port: customPort, exclusive: true }, done); });
  }
  const child = spawn(executable, applicationArgs, { cwd: root, windowsHide: true, stdio: 'pipe', env: {
    ...environment, MODELDOCK_SMOKE: profile.outputDir, MODELDOCK_DATA_DIR: profile.dataDir, MODELDOCK_SMOKE_NONCE: profile.nonce,
    MODELDOCK_SMOKE_GATEWAY_STARTUP: '1', MODELDOCK_SMOKE_GATEWAY_STARTUP_STAGE: stage, MODELDOCK_SMOKE_GATEWAY_PORT: String(customPort),
  } });
  let stderr = '', stdout = '', exit;
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-16 * 1024); });
  child.stdout.on('data', value => { stdout = (stdout + value).slice(-16 * 1024); });
  const exited = new Promise(done => {
    child.once('error', error => { exit = { error: String(error) }; done(exit); });
    child.once('exit', (code, signal) => { exit = { code, signal }; done(exit); });
  });
  try {
    const readyPath = join(stageOutput, 'gateway-startup-ready.json'), errorPath = join(stageOutput, 'electron-smoke-error.txt');
    const deadline = Date.now() + 60_000;
    while (!existsSync(readyPath) && Date.now() < deadline) {
      if (existsSync(errorPath)) throw new Error(readFileSync(errorPath, 'utf8'));
      if (exit) throw new Error(`QA process exited before ${stage} became ready: ${JSON.stringify(exit)} ${stderr}`);
      await pause(100);
    }
    assert.ok(existsSync(readyPath), `Startup stage ${stage} must report a usable application`);
    const ready = JSON.parse(readFileSync(readyPath, 'utf8'));
    assert.equal(ready.stage, stage); assert.equal(ready.pid, child.pid); assert.equal(ready.appReady, true);
    assert.equal(resolve(ready.dataDir), resolve(profile.dataDir)); assert.equal(ready.customPort, customPort);
    let network;
    if (stage === 'enabled' || stage === 'occupied') {
      const native = listeners(customPort), expectedPid = stage === 'enabled' ? child.pid : process.pid;
      assert.equal(native.length, 1, 'Exactly one IPv4 loopback listener may own the custom QA port');
      assert.ok(native.every(value => value.LocalAddress === '127.0.0.1' && value.LocalPort === customPort && value.OwningProcess === expectedPid), 'The native listener must belong to this QA process or its explicit occupied-port fixture');
      network = { listeners: native, http: await http(customPort, stage === 'occupied') };
    } else network = await noListener(customPort);
    assert.equal(exit, undefined, 'The application must remain alive while the runner inspects its startup result');
    writeFileSync(join(stageOutput, 'gateway-startup-release.json'), JSON.stringify({ stage, nonce: profile.nonce }), { flag: 'wx' });
    const status = await beforeDeadline(exited, 15_000, `${stage} clean shutdown`);
    assert.equal(status.code, 0); assert.equal(status.signal, null);
    if (existsSync(errorPath)) throw new Error(readFileSync(errorPath, 'utf8'));
    const validation = JSON.parse(readFileSync(join(stageOutput, 'gateway-startup-validation.json'), 'utf8'));
    assert.equal(validation.runnerReleased, true); assert.equal(validation.osStartupChanged, false);
    assert.equal(validation.final.gateway.requests - validation.ready.gateway.requests, stage === 'enabled' ? 1 : 0, 'The observed HTTP request must be handled by this instance, without an upstream inference request');
    const shutdown = stage === 'occupied' ? { occupiedFixtureStillOwnedByRunner: listeners(customPort).every(value => value.OwningProcess === process.pid) } : await noListener(customPort);
    if (stage === 'occupied') assert.equal(shutdown.occupiedFixtureStillOwnedByRunner, true);
    assert.equal(validation.encryptedDatabaseBackend, 'local-aes-gcm-qa');
    const result = { stage, pid: child.pid, dataDir: profile.dataDir, persistence, encryptedDatabaseBackend: validation.encryptedDatabaseBackend, initial: validation.initial, transitions: validation.transitions, ready: validation.ready, final: validation.final, appReady: validation.appReady, network, shutdown, layouts: validation.layouts, output: stageOutput };
    writeFileSync(join(stageOutput, 'gateway-startup-network-validation.json'), JSON.stringify(result, null, 2));
    results.push(result); previous = profile;
    console.log(JSON.stringify({ stage, pid: child.pid, gatewayRunning: validation.initial.gateway.running, savedPort: validation.final.settings.gatewayPort, passed: true }));
  } catch (error) {
    if (!exit) { child.kill(); await beforeDeadline(exited, 5000, `${stage} failed QA shutdown`).catch(() => {}); }
    writeFileSync(join(stageOutput, 'gateway-startup-runner-error.txt'), String(error));
    throw error;
  } finally {
    writeFileSync(join(stageOutput, 'gateway-startup-stderr.log'), stderr);
    writeFileSync(join(stageOutput, 'gateway-startup-stdout.log'), stdout);
    if (occupiedServer) { occupiedServer.closeAllConnections(); await new Promise(done => occupiedServer.close(done)); }
  }
}
assert.equal(new Set(results.map(result => result.pid)).size, 4, 'All four stages must start distinct native Electron processes');
assert.equal(new Set(results.map(result => result.dataDir)).size, 4, 'Each process must use a new verified smoke profile');
const report = { version: 1, ok: true, customPort, actualProcessStarts: results.length, exactPersistedDatabaseCopies: results.filter(result => result.persistence).length, encryptedDatabaseBackend: 'local-aes-gcm-qa', nativeWindowsTcpOwnership: true, externalLoopbackHttpVerified: true, operatingSystemLoginItemChanged: false, windowsLoginOrRebootTested: false, inferenceTested: false, results };
writeFileSync(join(output, 'gateway-startup-validation.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: true, processStarts: results.length, customPort, output }));
