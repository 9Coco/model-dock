import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { createSmokeProfile } from './smoke-profile.mjs';
import { verifyQaExecutable } from './smoke-package.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), noBuild = args.includes('--no-build'), ciNoSandbox = args.includes('--ci-no-sandbox'), x11 = args.includes('--x11'), values = args.filter(value => !['--no-build', '--ci-no-sandbox', '--x11'].includes(value));
if (values.length > 2 || values.some(value => value.startsWith('--'))) throw new Error('Usage: node scripts/smoke-electron.mjs [output] [dedicated-QA-ModelDock.exe] [--no-build] [--ci-no-sandbox]');
if (ciNoSandbox && (process.platform !== 'linux' || process.env.CI !== 'true')) throw new Error('--ci-no-sandbox is restricted to an explicit Linux CI smoke run.');
if (values.some(value => value.split(/[\\/]/).includes('..'))) throw new Error('Smoke paths must not contain traversal.');
const output = resolve(values[0] || 'work/electron-smoke');
let executable = electron, applicationArgs = [join(root, 'work/smoke-runtime')];
if (values[1]) { executable = verifyQaExecutable(resolve(values[1])); applicationArgs = []; }
else {
  if (!noBuild) {
    const npmCli = resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    if (existsSync(npmCli)) execFileSync(process.execPath, [npmCli, 'run', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true });
    else execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit', windowsHide: true, shell: process.platform === 'win32' });
  }
  execFileSync(process.execPath, [join(root, 'scripts/build-main.mjs'), '--smoke'], { cwd: root, stdio: 'inherit', windowsHide: true });
}
const profile = await createSmokeProfile(output);
if (x11) {
  if (process.platform !== 'linux') throw new Error('--x11 is only supported by the Linux smoke runner.');
  applicationArgs.unshift('--ozone-platform=x11');
}
if (ciNoSandbox) {
  applicationArgs.unshift('--no-sandbox');
}
const errorFile=resolve(output,'electron-smoke-error.txt');
if(existsSync(errorFile)) unlinkSync(errorFile);
const env = { ...process.env, MODELDOCK_SMOKE: profile.outputDir, MODELDOCK_DATA_DIR: profile.dataDir, MODELDOCK_SMOKE_NONCE: profile.nonce };
env.MODELDOCK_SMOKE_AUTH_MOCK = '1';
delete env.MODELDOCK_DEV_URL;
let noCatalogModelRequests = 0, connectionTestPosts = 0, codexModelRequests = 0;
const connectionRequests = [];
let claudeMessagesRequests = 0;
const jetBrainsRequests = [];
const upstream = createServer((req,res) => {
  if (req.method === 'POST' && ['/jetbrains/v1/chat/completions', '/jetbrains/v1/responses'].includes(req.url)) {
    const parts = []; req.on('data', part => parts.push(part)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const responses = req.url.endsWith('/responses');
      const ok = req.headers.authorization === 'Bearer synthetic-only' && body.model === (responses ? 'jb-responses-native' : 'jb-chat-native') && Array.isArray(responses ? body.input : body.messages);
      jetBrainsRequests.push({path:req.url,model:body.model,ok}); res.writeHead(ok ? 200 : 400, {'content-type':'application/json'});
      res.end(JSON.stringify(!ok ? {error:{message:'Synthetic JetBrains contract failed'}} : responses ? { id:'resp_jb',object:'response',status:'completed',model:body.model,output:[{id:'msg_jb',type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:8,output_tokens:2} } : { id:'chat_jb',object:'chat.completion',model:body.model,choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:8,completion_tokens:2} }));
    }); return;
  }

  if (req.url === '/claude/v1/messages' && req.method === 'POST') {
    const parts = []; req.on('data', part => parts.push(part));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const ok = req.headers.authorization === 'Bearer synthetic-only' && req.headers['x-api-key'] === undefined && req.headers['anthropic-version'] === '2023-06-01' && body.model === 'mock-claude' && Array.isArray(body.messages) && body.max_tokens > 0;
      claudeMessagesRequests++; res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-claude', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } } : { type: 'error', error: { type: 'invalid_request_error', message: 'Synthetic Messages contract failed' } }));
    }); return;
  }

  if (req.url === '/metadata/v1/models') {
    if (req.method !== 'GET' || req.headers.authorization !== 'Bearer synthetic-only') { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini', context_window: 4096, vision: false }, { id: 'gpt-4.1' }, { id: 'unknown-fixture-model' }] })); return;
  }
  if (req.url?.startsWith('/codex-native/models')) {
    codexModelRequests++;
    const target = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET' || target.searchParams.getAll('client_version').length !== 1 || target.searchParams.get('client_version') !== '0.159.0' || req.headers.version !== '0.159.0' || req.headers.originator !== 'codex_cli_rs' || req.headers['chatgpt-account-id'] !== 'mock-auth-workspace' || req.headers.authorization !== 'Bearer MOCK_ACCESS_AUTH_NETWORK') {
      res.statusCode = 400; res.end(JSON.stringify({ error: { code: 'invalid_client_version' } })); return;
    }
    res.end(JSON.stringify({ models: [
      { slug: 'mock-codex', display_name: 'Native Codex', visibility: 'list', context_window: 272000, input_modalities: ['text', 'image'], supports_parallel_tool_calls: true },
      { slug: 'mock-codex-hidden', visibility: 'hide' }, { slug: 'mock-codex-none', visibility: 'none' },
    ] })); return;
  }
  if (req.url?.startsWith('/no-catalog/')) {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      noCatalogModelRequests++;
      res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({error:{message:'This synthetic plan has no model catalog'}})); return;
    }
    if (req.method !== 'POST' || !['/no-catalog/v1/chat/completions','/no-catalog/v1/responses'].includes(req.url)) { res.writeHead(405); res.end(); return; }
    connectionTestPosts++;
    const parts=[]; req.on('data',part=>parts.push(part));
    req.on('end',()=>{
      res.setHeader('content-type','application/json');
      let body; try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{res.statusCode=400;res.end('{}');return;}
      const wireApi=req.url.endsWith('/responses')?'responses':'chat-completions';
      const respond=(statusCode,payload)=>{
        connectionRequests.push({model:body.model,wireApi,statusCode});
        // Give the renderer a deterministic busy frame for the model-selector checks.
        setTimeout(()=>{res.statusCode=statusCode;res.end(JSON.stringify(payload));},75);
      };
      if(req.headers.authorization!=='Bearer synthetic-only') { respond(401,{error:{message:'Synthetic key rejected'}}); return; }
      if(!['no-list-model','no-list-second-model'].includes(body.model)) { respond(404,{error:{message:'Synthetic model not found'}});return; }
      if((body.model==='no-list-second-model'&&wireApi!=='responses')||!Array.isArray(wireApi==='responses'?body.input:body.messages)) { respond(400,{error:{message:'Synthetic protocol mismatch'}});return; }
      if(wireApi==='responses') respond(200,{id:'mock-probe-response',object:'response',status:'completed',model:body.model,output:[{id:'msg_1',type:'message',role:'assistant',content:[{type:'output_text',text:'OK'}]}]});
      else respond(200,{id:'mock-probe-response',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}]});
    });
    return;
  }
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    if (req.headers.authorization !== 'Bearer synthetic-only') { res.writeHead(401,{'content-type':'application/json'}); res.end(JSON.stringify({error:{message:'synthetic authentication failure'}})); return; }
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({data:[{id:'mock-model',name:'已配置模型',context_window:64000,supports_tools:true},{id:'mock-fast',name:'快速模型',context_window:128000,supports_tools:true},{id:'mock-reasoner',name:'推理模型'}]}));
    return;
  }
  req.resume(); req.on('end',()=>{
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'mock-response',object:'chat.completion',model:'mock-model',usage:{prompt_tokens:7,completion_tokens:3,prompt_tokens_details:{cached_tokens:2}},choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));
  });
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
env.MODELDOCK_SMOKE_UPSTREAM=`http://127.0.0.1:${upstream.address().port}/v1`;
env.MODELDOCK_SMOKE_NO_CATALOG=`http://127.0.0.1:${upstream.address().port}/no-catalog/v1`;
env.MODELDOCK_SMOKE_METADATA_UPSTREAM=`http://127.0.0.1:${upstream.address().port}/metadata/v1`;
delete env.ELECTRON_RUN_AS_NODE;
function verifyConnectionNetwork() {
  const validation = JSON.parse(readFileSync(resolve(output,'connection-test-validation.json'),'utf8'));
  if (noCatalogModelRequests !== 0 || connectionTestPosts !== validation.expectedConnectionPostCalls || !isDeepStrictEqual(connectionRequests,validation.expectedConnectionRequests)) throw new Error('Connection test selected model, protocol, or duplicate request prevention failed');
  writeFileSync(resolve(output,'connection-network-validation.json'),JSON.stringify({noCatalogModelRequests,connectionTestPosts,connectionRequests},null,2));
  return validation;
}
const child = spawn(executable, applicationArgs, { cwd: root, env, windowsHide: true, stdio: 'pipe' });
let errorOutput = '';
child.stderr.on('data', chunk => { errorOutput += chunk; });
const deadline = setTimeout(() => { child.kill(); process.stderr.write(errorOutput); process.exit(1); }, 180000);
child.on('exit', code => {
  clearTimeout(deadline);
  upstream.close();
  try {
    if(existsSync(errorFile)) throw new Error(readFileSync(errorFile,'utf8'));
    const value = JSON.parse(readFileSync(resolve(output, 'electron-smoke.json'), 'utf8'));
    if (!value.bridge || !value.text.includes('ModelDock')) throw new Error('Renderer/preload bridge unavailable');
    if (env.MODELDOCK_SMOKE_JETBRAINS_ONLY === '1') {
      const result = JSON.parse(readFileSync(resolve(output,'jetbrains-ui-validation.json'),'utf8'));
      if (!result.ok || result.products.length !== 4 || jetBrainsRequests.length !== 4 || jetBrainsRequests.some(request=>!request.ok)) throw new Error('JetBrains UI/native gateway contract failed');
      writeFileSync(resolve(output,'jetbrains-network-validation.json'),JSON.stringify({requests:jetBrainsRequests},null,2));
      console.log(JSON.stringify({exitCode:code,bridge:value.bridge,jetBrains:result,requests:jetBrainsRequests,output}));
      process.exit(code || 0);
    }
    if (env.MODELDOCK_SMOKE_CLAUDE_ONLY === '1') {
      const result = JSON.parse(readFileSync(resolve(output,'claude-ui-validation.json'),'utf8'));
      if (!result.ok || claudeMessagesRequests !== 1) throw new Error('Claude configuration UI or Messages contract failed');
      console.log(JSON.stringify({ exitCode: code, bridge: value.bridge, claudeCode: result, claudeMessagesRequests, output }));
      process.exit(code || 0);
    }
    if (env.MODELDOCK_SMOKE_METADATA_ONLY === '1') {
      const result = JSON.parse(readFileSync(resolve(output, 'model-metadata-validation.json'), 'utf8'));
      if (!result.ok || !result.manualZeroAndFalseSaved || !result.rediscoveryPreserved) throw new Error('Model metadata verification failed');
      console.log(JSON.stringify({ exitCode: code, bridge: value.bridge, metadata: result, output }));
      process.exit(code || 0);
    }
    if (env.MODELDOCK_SMOKE_SIDEBAR_ONLY === '1') {
      const result = JSON.parse(readFileSync(resolve(output, 'sidebar-scroll-validation.json'), 'utf8'));
      if (!result.ok || !result.independentScroll || !result.configurationUnchanged) throw new Error('Independent sidebar scrolling validation failed');
      console.log(JSON.stringify({ exitCode: code, bridge: value.bridge, sidebarScroll: true, output }));
      process.exit(code || 0);
    }
    if (env.MODELDOCK_SMOKE_COMPACT_ONLY === '1') {
      const result = JSON.parse(readFileSync(resolve(output, 'compact-ui-validation.json'), 'utf8'));
      console.log(JSON.stringify({ exitCode: code, bridge: value.bridge, compactUi: true, output }));
      process.exit(code || 0);
    }
    if (env.MODELDOCK_SMOKE_USAGE_ONLY === '1') {
      const result = JSON.parse(readFileSync(resolve(output, 'usage-analytics-validation.json'), 'utf8'));
      if (!result.ok || !result.readonlyClientFiles || !result.rawMessagesNotStored) throw new Error('Usage analytics integration failed');
      console.log(JSON.stringify({ exitCode: code, bridge: value.bridge, usageRecords: result.clientEvents, output }));
      process.exit(code || 0);
    }
    if (env.MODELDOCK_SMOKE_AUTH_QUOTAS_ONLY === '1') {
      const result = JSON.parse(readFileSync(resolve(output, 'auth-quota-validation.json'), 'utf8'));
      if (!result.ok || !result.autoQueryAfterLogin || !result.sourceTokensNotInRenderer) throw new Error('Account quota integration failed');
      console.log(JSON.stringify({ exitCode: code, bridge: value.bridge, quotaAccounts: result.accountKinds, output }));
      process.exit(code || 0);
    }
    if (env.MODELDOCK_SMOKE_CONNECTION_ONLY === '1') {
      const result = verifyConnectionNetwork();
      if (!result.noDialog || !result.selectedSecond.ok || result.busyChecks.length !== result.expectedConnectionPostCalls) throw new Error('Inline connection model selection validation failed');
      console.log(JSON.stringify({ exitCode: code, bridge: value.bridge, connectionOnly: true, connectionTestRequests: connectionTestPosts, output }));
      process.exit(code || 0);
    }
    const integration = JSON.parse(readFileSync(resolve(output, 'electron-integration.json'), 'utf8'));
    if (integration.reply !== 'OK') throw new Error('Main-process gateway integration unavailable');
    if (env.MODELDOCK_SMOKE_TOOLS_ONLY === '1') {
      const tools = JSON.parse(readFileSync(resolve(output, 'tool-restore-connection-validation.json'), 'utf8'));
      if (!tools.aggregateExactModelSelection || !tools.originalFilesBackedUp || !tools.mcpPreserved || tools.restoredFileTools.length !== 3) throw new Error('Tool connection/restoration integration unavailable');
      console.log(JSON.stringify({ exitCode: code, bridge: value.bridge, toolsOnly: true, localMockRequest: integration.replyStatus, toolRestoration: true, output }));
      process.exit(code || 0);
    }
    verifyConnectionNetwork();
    if (codexModelRequests !== 2) throw new Error('Native Codex catalog must be fetched exactly twice');
    writeFileSync(resolve(output,'codex-catalog-network-validation.json'),JSON.stringify({codexModelRequests},null,2));
    console.log(JSON.stringify({ exitCode: code, bridge: value.bridge, title: value.title, localMockRequest: integration.replyStatus, screenshot: resolve(output, 'electron-smoke.png') }));
    process.exit(code || 0);
  } catch (error) { console.error(String(error), errorOutput); process.exit(1); }
});
