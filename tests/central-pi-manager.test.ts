import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { CentralPiManager } from '../src/main/central-pi-manager';

const managers: CentralPiManager[] = [];
const roots: string[] = [];
const key = 'local-only-'.repeat(4);
const worker = String.raw`
const http = require('node:http');
const { createHmac } = require('node:crypto');
const options = process.argv.slice(2);
const env = process.env;
const fs = require('node:fs');
fs.writeFileSync(require('node:path').join(__dirname, 'observed'), JSON.stringify({ options, privateDir:env.PI_CODING_AGENT_DIR,
  cwd: process.cwd(), leaked: !!env.OPENAI_API_KEY || !!env.ANTHROPIC_API_KEY || !!env.WIRE_PROXY_PORT || !!env.BASH_ENV,
  offline:env.PI_OFFLINE, telemetry:env.PI_TELEMETRY, connected: env.MODELDOCK_JB_CONNECTED_ROUTES && JSON.parse(env.MODELDOCK_JB_CONNECTED_ROUTES) }));
const nonce = env.MODELDOCK_JB_RELAY_NONCE;
const proof = createHmac('sha256', env.MODELDOCK_JB_RELAY_KEY).update('health:'+nonce).digest('hex');
const wrong = fs.existsSync(require('node:path').join(__dirname, 'wrong'));
http.createServer((req,res) => {
  if (req.headers.authorization !== 'Bearer '+proof) { res.writeHead(401).end(); return; }
  res.end(JSON.stringify({ id:'modeldock-central-pi', nonce:wrong?'someone-else':nonce }));
}).listen(18081, '127.0.0.1');
`;

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'modeldock-central-pi-test-'));
  roots.push(root);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const home = join(root, 'home');
  await mkdir(home);
  vi.stubEnv('HOME', home);
  const extension = join(root, 'the extension.mjs');
  await writeFile(extension, '');
  // Our fake Central mirrors the CLI process boundary. Its Pi is a separate
  // process; stopping the manager must release the worker's listening socket.
  const central = `#!${process.execPath}\nconst {spawn}=require('node:child_process');\nif(JSON.stringify(process.argv.slice(2,5))!==JSON.stringify(['run','pi','--'])) process.exit(90);\nconst child=spawn('pi',process.argv.slice(5),{stdio:'inherit'}); child.on('exit',(_,signal)=>process.exit(signal?1:0)); setInterval(()=>{if(require('node:fs').existsSync(require('node:path').join(__dirname,'exit-fixture'))) process.exit(23);},65);`;
  for (const [name, script] of [['central', central], ['pi', `#!${process.execPath}\n${worker}`]]) {
    const path = join(bin,name); await writeFile(path, script); await chmod(path, 0o700);
  }
  const mgr = new CentralPiManager(root, extension);
  managers.push(mgr);
  vi.stubEnv('PATH', [bin, process.env.PATH].join(delimiter));
  vi.stubEnv('OPENAI_API_KEY', 'test-vendor-key');
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-vendor-key');
  vi.stubEnv('BASH_ENV', '/untrusted-shell-hook');
  vi.stubEnv('WIRE_PROXY_PORT', '4444');
  return {root, home, bin, extension, mgr};
}

describe.skipIf(process.platform === 'win32')('explicit Central Pi lifecycle', () => {
  it('runs one isolated Pi without a prompt, verifies its nonce and stops its child tree', async () => {
    const {root, bin, extension, mgr} = await fixture();
    expect(mgr.isRunning(key)).toBe(false);
    await Promise.all([mgr.start(key), mgr.start(key)]);
    expect(mgr.isRunning(key)).toBe(true);
    expect(await mgr.ownsListener(key)).toBe(true);
    expect(await mgr.ownsListener('unknown')).toBe(false);
    const evidence = JSON.parse(await readFile(join(bin,'observed'), 'utf8'));
    expect(evidence).toMatchObject({ leaked:false, offline:'1', telemetry:'0' });
    expect(evidence.options).toEqual(['--mode','rpc','--no-session','--no-tools','--no-approve','--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--extension',extension]);
    expect(evidence.privateDir).toMatch(/central-pi\/run-[^/]+\/agent$/);
    expect(evidence.cwd).toMatch(/central-pi\/run-[^/]+\/work$/);
    expect(JSON.stringify(evidence)).not.toContain(key);
    await expect(mgr.start('other'.repeat(10))).rejects.toThrow('另一把');
    await Promise.all([mgr.stop(),mgr.stop()]);
    expect(mgr.isRunning(key)).toBe(false);
    expect(await readdir(join(root,'central-pi'))).toEqual([]);
    await mgr.start('next-key'.repeat(5));
    expect(mgr.isRunning('next-key'.repeat(5))).toBe(true);
  });

  it('adapts only known Central data from an already-connected Pi, without executing or copying user code and credentials', async () => {
    const {mgr, home, root, bin} = await fixture();
    const providerDir = join(home, '.pi', 'agent', 'extensions');
    const configDir = join(home, '.jetbrains-central');
    await mkdir(providerDir, {recursive:true});
    await mkdir(configDir);
    const port = 19516, secret = 'c'.repeat(32);
    const base = `http://127.0.0.1:${port}/wire/${secret}/pi/`;
    const marker = join(root,'user-code-executed');
    await writeFile(join(configDir,'config.json'), JSON.stringify({proxy_port:port, proxy_secret:secret}));
    // Use the literal provider registration line shipped by Central 2.2. The
    // rest of this intentionally hostile fixture must never execute or travel.
    const sample = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\nexport default function(pi) {\n  pi.registerProvider("openai", { baseUrl: "${base}openai/v1", apiKey: "sk-forbidden-test-key" });\n  pi.registerProvider("anthropic", { baseUrl: "${base}anthropic", apiKey: "unrelated-token" });\n}\n`;
    const providerFile = join(providerDir,'jetbrains-central.ts');
    await writeFile(providerFile, sample);
    await mgr.start(key);
    const evidence = JSON.parse(await readFile(join(bin,'observed'),'utf8'));
    expect(evidence.connected).toEqual({openai:base+'openai/v1',anthropic:base+'anthropic'});
    const generated = await readFile(join(evidence.privateDir,'extensions','modeldock-connected.js'),'utf8');
    for (const material of ['sk-forbidden-test-key','unrelated-token',secret,marker]) expect(generated).not.toContain(material);
    // Evaluate ModelDock's own fixed bootstrap against a Pi API double. A new
    // Central-supplied extension or restricted policy must always win in full.
    function replayBootstrap(extraExtension: boolean, registered: string | undefined) {
      const registrations = new Map<string, {baseUrl:string;apiKey:string}>();
      const argv = ['pi', '--extension', 'the relay'];
      if (extraExtension) argv.push('--extension', 'current-policy.ts');
      const install = runInNewContext(generated.replace('export default function (pi)', '(function (pi)') + ')', {
        process:{argv, env:{MODELDOCK_JB_CONNECTED_ROUTES: JSON.stringify(evidence.connected)}},
      });
      install({registerProvider:(id: string, cfg: {baseUrl:string;apiKey:string})=>registrations.set(id,cfg),
        on: (_name: string, handler: (event: object, ctx: object)=>void) => handler({}, {
          modelRegistry:{getRegisteredProviderConfig:(id: string)=>id===registered ? {} : undefined},
        }),
      });
      return registrations;
    }
    expect(replayBootstrap(false,undefined).get('openai')).toMatchObject({baseUrl:base+'openai/v1',apiKey:'modeldock-local-placeholder'});
    expect(replayBootstrap(true,undefined).size).toBe(0);
    expect(replayBootstrap(false,'amazon-bedrock').size).toBe(0);
    expect(JSON.stringify(evidence)).not.toContain('sk-forbidden-test-key');
    expect(await readdir(root)).not.toContain('user-code-executed');
    await mgr.stop();
    // Never trust another service that merely imitates Central's URL shape.
    await writeFile(providerFile,sample.replaceAll(String(port),'22222'));
    await mgr.start(key);
    expect(JSON.parse(await readFile(join(bin,'observed'),'utf8')).connected).toBeUndefined();
  });

  it('never adopts another listener or sends it a credential, and permits retry after release', async () => {
    const {bin, mgr} = await fixture();
    let hits = 0;
    const other = createServer((_req,res)=>{ hits++; res.end(); });
    await new Promise<void>((resolve,reject)=>{other.once('error',reject);other.listen(18081,'127.0.0.1',resolve);});
    try {
      await expect(mgr.start(key)).rejects.toThrow('18081');
      expect(hits).toBe(0);
      expect(await readdir(bin)).not.toContain('observed');
    } finally { await new Promise<void>(resolve=>other.close(()=>resolve())); }
    await mgr.start(key);
  });

  it('rejects wrong identity even on the right port and allows stop during startup', async () => {
    const {mgr, bin} = await fixture();
    await writeFile(join(bin,'wrong'),'');
    const started = expect(mgr.start(key)).rejects.toThrow();
    for (let i=0; i<80 && !(await readdir(bin)).includes('observed'); i++) await delay(25);
    expect(await readdir(bin)).toContain('observed');
    await delay(250);
    expect(mgr.isRunning(key)).toBe(false);
    await mgr.stop();
    await started;
    await rm(join(bin,'wrong'));
    await mgr.start(key);
  });

  it('releases an orphaned worker if the Central wrapper exits unexpectedly', async () => {
    const {mgr, bin,root} = await fixture();
    await mgr.start(key);
    await writeFile(join(bin,'exit-fixture'), '');
    for (let i=0; i<100 && (await readdir(join(root,'central-pi'))).length; i++) await delay(25);
    expect(await mgr.ownsListener(key)).toBe(false);
    expect(await readdir(join(root,'central-pi'))).toEqual([]);
    await rm(join(bin,'exit-fixture'));
    await mgr.start(key);
  });

  it('reports early child failure without exposing its output, rejects header injection', async () => {
    const {mgr,bin} = await fixture();
    await writeFile(join(bin,'central'), `#!${process.execPath}\nprocess.stderr.write('secret-error-from-account'); process.exit(1);`);
    await expect(mgr.start('x\r\ny')).rejects.toThrow('密钥格式');
    await expect(mgr.start(key)).rejects.toThrow('central login');
    expect(mgr.isRunning(key)).toBe(false);
  });
});
