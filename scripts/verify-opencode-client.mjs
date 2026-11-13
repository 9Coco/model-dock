import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Explicitly selected official client, isolated XDG profile, synthetic key and
// mock inference only. Never run a real user service or alter its server URL.
const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/verify-opencode-client.mjs <official-opencode-cli>');
const output = resolve('work/opencode-native-client'); mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(output, 'profile-'));
const bundle = join(output, 'adapters.cjs');
await build({ entryPoints: ['src/main/adapters.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external' });
const { buildConfig } = createRequire(import.meta.url)(bundle);
const calls = [];
const server = createServer((request, response) => {
  let body = ''; request.setEncoding('utf8'); request.on('data', part => { body += part; });
  request.on('end', () => {
    if (request.method !== 'POST' || request.headers.authorization !== 'Bearer synthetic-client-key') { response.writeHead(401); response.end(); return; }
    const value = JSON.parse(body); calls.push({ path: request.url, model: value.model, streaming: value.stream });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (value, event) => response.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`);
    if (request.url === '/v1/chat/completions') {
      send({ id: 'fixture-chat', object: 'chat.completion.chunk', model: value.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'OPENCODE_DESKTOP_OK' }, finish_reason: null }] });
      send({ id: 'fixture-chat', object: 'chat.completion.chunk', model: value.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
      response.end('data: [DONE]\n\n');
    } else if (request.url === '/v1/responses') {
      const item = { id: 'msg-fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OPENCODE_DESKTOP_OK', annotations: [] }] };
      const base = { id: 'resp-fixture', object: 'response', model: value.model, created_at: 1 };
      const event = (type, data) => send({ type, ...data }, type);
      event('response.created', { response: { ...base, status: 'in_progress', output: [] } });
      event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'OPENCODE_DESKTOP_OK' });
      event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'OPENCODE_DESKTOP_OK' });
      event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
      event('response.output_item.done', { output_index: 0, item });
      event('response.completed', { response: { ...base, status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }); response.end();
    } else { response.end(); }
  });
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const provider = { id: 'fixture', kind: 'openai-compatible', name: 'Fixture', enabled: true, hasSecret: true, authStatus: 'ready', baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
const models = ['chat-completions', 'responses'].map((wireApi, index) => ({ id: `m${index}`, providerId: provider.id, upstreamId: `fixture-${index}`, alias: `fixture-${index}`, displayName: `Fixture ${wireApi}`, wireApi, contextWindow: 32000, tools: true, vision: false, enabled: true }));
const store = { listBindings: () => [{ id: 'opencode-desktop', name: 'Fixture', enabled: true, mode: 'direct', providerIds: [provider.id], modelIds: models.map(m => m.id), defaultModelId: models[0].id }], listModels: () => models, listProviders: () => [provider], getProvider: () => provider, getSecret: () => ({ apiKey: 'synthetic-client-key' }), gatewayKey: () => 'synthetic-local-key' };
const env = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_CONFIG_CONTENT: '', OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: '', OPENCODE_DB: join(profile, 'fixture.db') };
for (const key of ['CONFIG', 'DATA', 'CACHE', 'STATE']) { env[`XDG_${key}_HOME`] = join(profile, key.toLowerCase()); mkdirSync(env[`XDG_${key}_HOME`], { recursive: true }); }
const configDir = join(env.XDG_CONFIG_HOME, 'opencode'); mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'opencode.json'), buildConfig(store, 'opencode-desktop', 18181, true, profile).content);
const results = [];
try {
  for (const model of models) {
    const result = await new Promise((done, reject) => {
      const child = spawn(executable, ['run', '--standalone', '--format', 'json', '--model', `modeldock/${model.upstreamId}`, 'Reply exactly OPENCODE_DESKTOP_OK'], { cwd: profile, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => {
        writeFileSync(join(profile, `${model.id}-output.txt`), stdout + stderr);
        child.kill(); reject(new Error(`Native client fixture timed out; inspect ${profile}`));
      }, 60000);
      child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); done({ code, stdout, stderr }); });
    });
    writeFileSync(join(profile, `${model.id}-output.txt`), result.stdout + result.stderr);
    assert.equal(result.code, 0, `Native client failed; inspect ${profile}`);
    assert.ok(result.stdout.includes('OPENCODE_DESKTOP_OK'), `No native text output; inspect ${profile}`);
    assert.ok(calls.some(call => call.path === (model.wireApi === 'responses' ? '/v1/responses' : '/v1/chat/completions') && call.model === model.upstreamId));
    results.push({ protocol: model.wireApi, textReceived: true, realUpstreamId: true });
  }
  const result = { ok: true, executable, profile, results, calls, realUserConfigurationChanged: false, liveProviderInferenceTested: false };
  writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await new Promise(done => server.close(done)); }
