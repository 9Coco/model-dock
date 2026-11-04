// Loaded by the real Pi CLI after JetBrains Central registers its providers.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';

const supportedApis = new Map([
  ['openai-responses', 'openai'], ['openai-completions', 'openai'], ['anthropic-messages', 'anthropic'],
]);
const centralBasePattern = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/wire\/[a-f0-9]{32}\/pi\/(openai|anthropic)(?:\/v1)?\/?$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const idLike = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:+-]{0,180}$/.test(value);
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

class RelayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(ok, message = 'Invalid Chat Completions request.') {
  if (!ok) throw new RelayError(400, message);
}
function fields(value, allowed) {
  requireValue(object(value) && Object.keys(value).every(key => allowed.includes(key)), 'Unsupported or invalid request field.');
}

// Credentials are injected by Central into its own daemon. Do not consult Pi's personal auth.
export function centralModels(registry) {
  if (typeof registry?.getRegisteredProviderConfig !== 'function' || typeof registry?.streamSimple !== 'function') {
    throw new RelayError(503, 'Pi 1.5 or newer with Central providers is required.');
  }
  const found = new Map();
  for (const model of registry.getAll()) {
    if (!idLike(model.provider) || !idLike(model.id) || !supportedApis.has(model.api)) continue;
    const config = registry.getRegisteredProviderConfig(model.provider);
    const match = typeof model.baseUrl === 'string' && centralBasePattern.exec(model.baseUrl);
    if (!match || Number(match[1]) > 65535 || supportedApis.get(model.api) !== match[2] ||
        model.provider !== match[2] || config?.baseUrl !== model.baseUrl || config.oauth || config.streamSimple ||
        registry.getRegisteredNativeProvider?.(model.provider)) continue;
    found.set(model.provider + '/' + model.id, model);
  }
  return found;
}

// Use a direct socket. Do not follow redirects or forward SDK-provided credentials/headers
// to a different route, even if a provider supplies a request-time base URL override.
function centralFetch(model, onStatus) {
  const base = model.baseUrl.replace(/\/$/, '');
  const root = base.replace(/\/v1$/, '');
  const path = { 'openai-responses': '/v1/responses', 'openai-completions': '/v1/chat/completions',
    'anthropic-messages': '/v1/messages' }[model.api];
  return async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    // Anthropic SDK can add ?beta=true on this same endpoint.
    if (url.origin + url.pathname !== root + path || url.username || url.password || url.hash ||
        [...url.searchParams].some(([key, value]) => key !== 'beta' || value !== 'true') || req.method !== 'POST') {
      throw new Error('Pi attempted to leave the selected Central route.');
    }
    const headers = Object.fromEntries(req.headers);
    delete headers.host;
    for (const name of ['authorization','x-api-key','proxy-authorization','cookie','x-goog-api-key']) delete headers[name];
    headers['accept-encoding'] = 'identity';
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(url, { method: 'POST', headers, agent: false, signal: req.signal }, incoming => {
        const raw = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) raw.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        const status = incoming.statusCode ?? 502;
        onStatus(status);
        if (status >= 300 && status < 400) {
          incoming.resume(); reject(new Error('Central redirects are unsupported.')); return;
        }
        const body = status === 204 || status === 205 ? null : Readable.toWeb(incoming);
        resolve(new Response(body, { status, headers: raw }));
      });
      outgoing.on('error', reject);
      if (req.body) {
        const body = Readable.fromWeb(req.body);
        body.on('error', error => outgoing.destroy(error));
        outgoing.once('close', () => body.destroy());
        body.pipe(outgoing);
      } else outgoing.end();
    });
  };
}

function parts(content, images = false) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  requireValue(Array.isArray(content));
  return content.map(part => {
    if (part?.type === 'text') {
      fields(part, ['type','text']); requireValue(typeof part.text === 'string'); return part;
    }
    requireValue(images && part?.type === 'image_url', 'Only local image data and text parts are supported.');
    fields(part, ['type','image_url']); fields(part.image_url, ['url','detail']);
    requireValue(part.image_url.detail == null || part.image_url.detail === 'auto');
    const match = typeof part.image_url.url === 'string' && /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/]+=*)$/.exec(part.image_url.url);
    requireValue(match, 'Only embedded image data is supported.');
    return { type: 'image', mimeType: match[1], data: match[2] };
  });
}

export function chatRequest(body, model) {
  fields(body, ['model','messages','stream','stream_options','max_tokens','max_completion_tokens','temperature','tools','tool_choice',
    'parallel_tool_calls','n','reasoning_effort','store','top_p','stop','frequency_penalty','presence_penalty','logprobs','response_format']);
  requireValue(Array.isArray(body.messages) && body.messages.length);
  requireValue(body.n === undefined || body.n === 1);
  requireValue(body.store === undefined || body.store === false);
  requireValue(body.stream === undefined || typeof body.stream === 'boolean');
  if (body.stream_options !== undefined) {
    fields(body.stream_options, ['include_usage']);
    requireValue(body.stream === true && typeof body.stream_options.include_usage === 'boolean');
  }
  const options = {};
  const limit = body.max_completion_tokens ?? body.max_tokens;
  if (body.max_tokens !== undefined || body.max_completion_tokens !== undefined) {
    requireValue(Number.isSafeInteger(limit) && limit > 0 &&
      (body.max_tokens === undefined || body.max_completion_tokens === undefined));
    options.maxTokens = limit;
  }
  if (body.temperature !== undefined) {
    requireValue(typeof body.temperature === 'number' && body.temperature >= 0 && body.temperature <= 2); options.temperature = body.temperature;
  }
  const native = {};
  const anthropic = model.api === 'anthropic-messages';
  if (body.top_p !== undefined) {
    requireValue(typeof body.top_p === 'number' && body.top_p >= 0 && body.top_p <= 1);
    native.top_p = body.top_p;
  }
  if (body.stop != null) {
    const stops = typeof body.stop === 'string' ? [body.stop] : body.stop;
    requireValue(Array.isArray(stops) && stops.length <= 4 && stops.every(s => typeof s === 'string' && s));
    if (stops.length) {
      requireValue(model.api !== 'openai-responses', 'The Responses route does not accept stop sequences.');
      native[anthropic ? 'stop_sequences' : 'stop'] = stops;
    }
  }
  if (body.response_format !== undefined) {
    fields(body.response_format, ['type']); requireValue(body.response_format.type === 'text', 'Only text responses are enabled.');
  }
  requireValue(body.logprobs === undefined || body.logprobs === false);
  for (const field of ['frequency_penalty','presence_penalty']) {
    if (body[field] !== undefined && body[field] !== 0) {
      requireValue(model.api === 'openai-completions' && typeof body[field] === 'number' && Math.abs(body[field]) <= 2);
      native[field] = body[field];
    }
  }
  const choice = body.tool_choice;
  if (choice !== undefined) {
    if (choice === 'none' || choice === 'auto') options.toolChoice = choice;
    else {
      requireValue(Array.isArray(body.tools) && body.tools.length, 'Explicit tool choice requires tools.');
      if (choice === 'required') native.tool_choice = anthropic ? {type:'any'} : 'required';
      else {
        fields(choice, ['type','function']); fields(choice.function, ['name']);
        const name = choice.function.name;
        requireValue(choice.type === 'function' && safeName(name) && body.tools.some(t => t?.function?.name === name));
        if (anthropic) native.tool_choice = {type:'tool',name};
        else native.tool_choice = model.api === 'openai-responses' ? {type:'function',name} : choice;
      }
    }
  }
  if (body.parallel_tool_calls !== undefined) {
    requireValue(typeof body.parallel_tool_calls === 'boolean');
    if (!anthropic) native.parallel_tool_calls = body.parallel_tool_calls;
    else if (Array.isArray(body.tools) && body.tools.length && choice !== 'none') {
      native.tool_choice = {type:'auto', ...native.tool_choice, disable_parallel_tool_use:!body.parallel_tool_calls};
    }
  }
  if (Object.keys(native).length) options.onPayload = payload => ({...payload, ...native});
  if (body.reasoning_effort !== undefined) {
    requireValue(['none','minimal','low','medium','high','xhigh','max'].includes(body.reasoning_effort));
    if (body.reasoning_effort !== 'none') {
      requireValue(model.reasoning, 'Reasoning is unsupported for this model.'); options.reasoning = body.reasoning_effort;
    }
  }
  const pending = new Map();
  const messages = body.messages.map(message => {
    const timestamp = Date.now();
    const role = message?.role;
    if (role === 'tool') {
      fields(message, ['role','content','tool_call_id']);
      const toolName = pending.get(message.tool_call_id);
      requireValue(toolName, 'Tool result has no matching call.');
      pending.delete(message.tool_call_id);
      return { role: 'toolResult', toolCallId: message.tool_call_id, toolName, content: parts(message.content, model.input?.includes('image')), isError: false, timestamp };
    }
    requireValue(!pending.size, 'Missing tool results.');
    if (role === 'system' || role === 'developer' || role === 'user') {
      fields(message, ['role','content']);
      return { role: role === 'developer' ? 'system' : role, content: parts(message.content, role === 'user' && model.input?.includes('image')), timestamp };
    }
    requireValue(role === 'assistant');
    fields(message, ['role','content','tool_calls','reasoning_content']);
    requireValue(message.reasoning_content === undefined || typeof message.reasoning_content === 'string');
    const content = message.content == null ? [] : parts(message.content);
    if (message.tool_calls !== undefined) {
      requireValue(Array.isArray(message.tool_calls));
      for (const call of message.tool_calls) {
        fields(call, ['id','type','function']); fields(call.function, ['name','arguments']);
        requireValue(call.type === 'function' && typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 512 &&
          !pending.has(call.id) && safeName(call.function.name) && typeof call.function.arguments === 'string');
        let args;
        try { args = JSON.parse(call.function.arguments); } catch { throw new RelayError(400, 'Invalid tool arguments JSON.'); }
        requireValue(object(args)); pending.set(call.id, call.function.name);
        content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: args });
      }
    }
    return { role, content, api: model.api, provider: model.provider, model: model.id, usage: zeroUsage,
      stopReason: pending.size ? 'toolUse' : 'stop', timestamp };
  });
  requireValue(!pending.size, 'Missing tool results.');
  const context = { messages };
  if (body.tools !== undefined) {
    requireValue(Array.isArray(body.tools));
    const names = new Set();
    context.tools = body.tools.map(tool => {
      fields(tool, ['type','function']); fields(tool.function, ['name','description','parameters','strict']);
      const fn = tool.function;
      requireValue(tool.type === 'function' && safeName(fn.name) && !names.has(fn.name));
      requireValue(fn.parameters === undefined || object(fn.parameters));
      requireValue(fn.description === undefined || typeof fn.description === 'string');
      requireValue(fn.strict === undefined || typeof fn.strict === 'boolean');
      names.add(fn.name);
      return { name: fn.name, description: fn.description ?? '', parameters: fn.parameters ?? { type: 'object', properties: {} },
        ...(fn.strict === undefined ? {} : {constrainedSampling: fn.strict ? {type:'json_schema',strict:'require'} : false}) };
    });
  }
  return { context, options };
}

function toolCall(part) {
  if (part.argumentsError || !part.id || !safeName(part.name) || !object(part.arguments)) throw new RelayError(502, 'Invalid tool call from Central.');
  return { id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.arguments) } };
}
function resultUsage(usage) {
  if (!usage) return undefined;
  return { prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite, completion_tokens: usage.output,
    total_tokens: usage.totalTokens, prompt_tokens_details: { cached_tokens: usage.cacheRead } };
}
const errorPayload = (message, status) => ({ error: { message, type: status >= 500 ? 'upstream_error' : 'invalid_request_error' } });
function json(res, status, payload) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify(payload));
}

async function runChat(registry, body, res, signal) {
  const model = centralModels(registry).get(body.model);
  if (!model) throw new RelayError(404, 'Unknown Central model. Discover the models in this session first.');
  const { context, options } = chatRequest(body, model);
  const common = { id: 'chatcmpl-' + randomUUID(), created: Math.floor(Date.now()/1000), model: body.model };
  const chunk = (delta, finish_reason = null) => ({ ...common, object:'chat.completion.chunk', choices:[{index:0, delta, finish_reason}] });
  const send = async payload => {
    if (signal.aborted) throw new Error('Disconnected');
    if (!res.headersSent) res.writeHead(200, {'content-type':'text/event-stream', 'cache-control':'no-store'});
    if (!res.write('data: ' + JSON.stringify(payload) + '\n\n')) await once(res, 'drain', { signal });
  };
  let upstreamStatus;
  const events = registry.streamSimple(model, context, { ...options, signal,
    apiKey: 'central-local-placeholder', transport:'sse', maxRetries:0, fetch:centralFetch(model, status => { upstreamStatus = status; }) });
  let started = false;
  let done;
  const sentText = new Map();
  const sentCalls = new Map();
  for await (const event of events) {
    if (event.type === 'error') {
      const messages = { 401:'JetBrains Central requires login.', 403:'This license cannot access the selected Central model.',
        404:'The selected model is unavailable through Central.', 429:'JetBrains Central quota or rate limit reached.' };
      throw new RelayError(messages[upstreamStatus] ? upstreamStatus : 502, messages[upstreamStatus] ?? 'The Central model request failed.');
    }
    if (event.type === 'start') started = true;
    else if (!started || done) throw new RelayError(502, 'Invalid upstream event order.');
    if (event.type === 'done') { done = event.message; continue; }
    if (body.stream !== true) continue;
    if (event.type === 'start') await send(chunk({role:'assistant'}));
    if (event.type === 'text_delta') {
      sentText.set(event.contentIndex, (sentText.get(event.contentIndex) ?? '') + event.delta);
      await send(chunk({content:event.delta}));
    }
    // Some adapters deliver tool arguments only at the end. Emit one authoritative delta per call.
    if (event.type === 'toolcall_end') {
      const call = toolCall(event.toolCall);
      sentCalls.set(event.contentIndex, call);
      await send(chunk({tool_calls:[{index:sentCalls.size - 1, ...call}]}));
    }
  }
  const finish = {stop:'stop',length:'length',toolUse:'tool_calls'}[done?.stopReason];
  if (!finish || !Array.isArray(done.content)) throw new RelayError(502, 'Incomplete Central response.');
  const usage = resultUsage(done.usage);
  if (body.stream) {
    for (const [index, part] of done.content.entries()) {
      if (part.type === 'text') {
        const previous = sentText.get(index) ?? '';
        if (!part.text.startsWith(previous)) throw new RelayError(502, 'Inconsistent Central text stream.');
        const tail = part.text.slice(previous.length);
        if (tail) await send(chunk({content:tail}));
      } else if (part.type === 'toolCall') {
        const actual = toolCall(part), previous = sentCalls.get(index);
        if (!previous) {
          await send(chunk({tool_calls:[{index:sentCalls.size, ...actual}]}));
          sentCalls.set(index, actual);
        } else if (JSON.stringify(previous) !== JSON.stringify(actual)) throw new RelayError(502, 'Inconsistent Central tool stream.');
      }
    }
    await send(chunk({}, finish));
    if (body.stream_options?.include_usage) await send({...common, object:'chat.completion.chunk', choices:[], usage});
    res.end('data: [DONE]\n\n');
  } else {
    const calls = done.content.filter(part => part.type === 'toolCall').map(toolCall);
    const text = done.content.filter(part => part.type === 'text').map(part => part.text).join('');
    const message = {role:'assistant',content:text || (calls.length ? null : ''), ...(calls.length ? {tool_calls:calls} : {})};
    json(res, 200, {...common, object:'chat.completion', choices:[{index:0,message,finish_reason:finish}], usage});
  }
}
function bearer(value, key) {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value), expected = Buffer.from('Bearer ' + key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(req) {
  let size = 0;
  const buffers = [];
  for await (const buffer of req) {
    size += buffer.length;
    if (size > 16 * 1024 * 1024) throw new RelayError(413, 'Chat request is too large.');
    buffers.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new RelayError(400, 'Invalid request JSON.'); }
}

export function makeRelay(registry, key, nonce) {
  if (typeof key !== 'string' || key.length < 32 || !nonce) throw new Error('ModelDock relay session is unavailable.');
  const healthKey = createHmac('sha256', key).update('health:' + nonce).digest('hex');
  return createServer(async (req, res) => {
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    try {
      const health = req.method === 'GET' && req.url === '/health';
      if (!bearer(req.headers.authorization, health ? healthKey : key)) throw new RelayError(401, 'Unauthorized.');
      if (health) {
        if (!centralModels(registry).size) throw new RelayError(503, 'No supported Central provider registered in Pi.');
        json(res, 200, {id:'modeldock-central-pi', nonce}); return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        const data = Array.from(centralModels(registry), ([id, m]) => ({id, object:'model', owned_by:'jetbrains-central', name:m.name,
          context_window:m.contextWindow, max_output_tokens:m.maxTokens, input_modalities:m.input, supports_tools:true, thinking:m.reasoning}));
        if (!data.length) throw new RelayError(503, 'No supported local JetBrains Central providers are registered in Pi.');
        json(res, 200, {object:'list',data}); return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw new RelayError(404, 'Unknown relay endpoint.');
      const body = await readBody(req);
      requireValue(object(body) && typeof body.model === 'string');
      await runChat(registry, body, res, abort.signal);
    } catch (err) {
      if (abort.signal.aborted || res.destroyed) return;
      const status = err instanceof RelayError ? err.status : 502;
      const payload = errorPayload(err instanceof RelayError ? err.message : 'Central model request failed.', status);
      if (res.headersSent) res.end('data: ' + JSON.stringify(payload) + '\n\n');
      else json(res, status, payload);
    } finally { abort.abort(); }
  });
}

export default function centralPiExtension(pi) {
  let server;
  pi.on('session_start', async (_event, ctx) => {
    if (server) return;
    server = makeRelay(ctx.modelRegistry, process.env.MODELDOCK_JB_RELAY_KEY, process.env.MODELDOCK_JB_RELAY_NONCE);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(18081, '127.0.0.1', resolve);
    });
  });
  pi.on('session_shutdown', () => {
    if (server) { server.close(); server.closeAllConnections(); server = undefined; }
  });
}
