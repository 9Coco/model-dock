/**
 * Offline probe for the reviewed Copilot Chat 0.76.0 bundle.
 * Usage: node scripts/verify-vscode-deepseek-client.mjs --extension-dir <copilot-dir>
 * Uses synthetic messages and extracts only the named functions into a VM.
 * No extension activation, user settings, credentials, HTTP or upstream calls.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--extension-dir' || !args[1]) {
  console.error('Usage: node scripts/verify-vscode-deepseek-client.mjs --extension-dir <copilot-extension-directory>');
  process.exit(2);
}
const directory = resolve(args[1]);
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'copilot-chat', 'Expected the Copilot Chat extension.');
assert.equal(manifest.version, '0.76.0', 'Review the extraction markers for this Copilot version.');
const bundle = readFileSync(join(directory, 'dist', 'extension.js'), 'utf8');

function extract(start, end) {
  const first = bundle.indexOf(start);
  assert(first >= 0, `Missing marker: ${start}`);
  assert.equal(bundle.indexOf(start, first + start.length), -1, `Ambiguous marker: ${start}`);
  const last = bundle.indexOf(end, first + start.length);
  assert(last > first && last - first < 15000, `Unexpected extraction range for ${start}`);
  return bundle.slice(first, last);
}

// The actual custom provider, serializer, round renderer and Chat delta reader
// run below. The fixtures supply enum constants, config/DI services and JSX nodes.
const kinds = { Text: 'text', Image: 'image', Opaque: 'opaque', CacheBreakpoint: 'cache' };
const raw = { ChatCompletionContentPartKind: kinds, ChatRole: { System: 0, User: 1, Assistant: 2, Tool: 3 } };
const roles = { System: 'system', User: 'user', Assistant: 'assistant', Tool: 'tool' };
const languageApi = {
  LanguageModelChatMessageRole: roles,
  LanguageModelTextPart: class { constructor(value) { this.value = value; } },
  LanguageModelThinkingPart: class { constructor(value, id, metadata) { Object.assign(this, { value, id, metadata }); } },
  LanguageModelToolCallPart: class { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } },
  LanguageModelDataPart: class {},
};
const context = vm.createContext({
  assert, eD: raw, h8e: { ChatRole: roles }, Ekn: raw, Ja: { ThinkingData: 'thinking' },
  wkn: { PromptElement: class {} }, Nl: { AssistantMessage: 'assistant', UserMessage: 'user', useKeepWith: () => 'keep' },
  vscpp: (ctor, props, ...children) => ({ ctor, props, children }), XLi: 'tool', JLi: 5, sn: { None: null },
  H: { Advanced: { ReasoningEffortOverride: 'effortOverride' } },
  am: languageApi, Sg: languageApi, bBn: languageApi, eL: { Raw: raw },
  kT: { PromptElement: class {}, AssistantMessage: 'assistant', SystemMessage: 'system' }, vscppf: 'fragment',
  gt: () => 'synthetic-thinking-id', _d: value => createHash('sha256').update(value).digest('hex'),
}, { codeGeneration: { strings: false, wasm: false } });

const functions = [
  extract('function vMi(t,e,n){', 'var mD=class'),
  extract('function gxn(t){', 'function fxn('),
  extract('function UTi(t){', 'var Ywe=class'),
  extract('function t9(t){', 'var Zb=class'),
  extract('var a5e=class t{', ';var Fh='),
  extract('var Zne=class extends wkn.PromptElement', ';function Wwe('),
  extract('function Wwe(t){', 'function Zwe('),
  extract('function cEe(t){', 'function _$e('),
  extract('function lpn(t,e={}){', 'ir();Ve();ze();var q9a='),
  extract('function cMi(t){', ';var Uh='),
  extract('function dIn(t){', 'function RSi('),
  extract('function mI(t,e){', 'var On='),
  extract('function $$e(t,e,n){', 'function GSn('),
  'var ' + extract('pki=["', ';function sne('),
  extract('function Sw(t){', 'function c0('),
  extract('function mki(t){', 'function jCe('),
];
const createEndpoint = extract('async createOpenAIEndPoint(e){let n=e.configuration?.models?.find', 'getModelsBaseUrl(e)');
const renderRound = extract('renderOneToolCallRound(n,r,o,a,s,c){', '};al=R');
const createBody = extract('createRequestBody(n){if(this.useResponsesApi){', 'interceptBody(n)');
const completionsCallback = extract('getCompletionsCallback(){let n=!!this.modelMetadata.capabilities.supports.thinking;', '_isReservedHeader(n)');
const customBody = extract('get useMessagesApi(){return!!this.modelMetadata.supported_endpoints?.includes("/v1/messages")}get supportsStatefulResponses()', '_isReservedHeader(e)');
const useResponsesApi = extract('get useResponsesApi(){return this.modelMetadata.supported_endpoints', 'get useWebSocketResponsesApi()');
vm.runInContext(`${functions.join(';\n')};
  var uG = { Raw: eD, OutputMode: { OpenAI: 2 }, toMode: (_mode, message) => mIn(message) };
  class OpenAIEndpoint {
    ${useResponsesApi} ${createBody} ${completionsCallback}
  }
  class IM extends OpenAIEndpoint { ${customBody} }
  var provider = { _name: 'customendpoint', ${createEndpoint},
    _instantiationService: { createInstance(klass, metadata, _key, url) {
      return Object.assign(new klass(), { modelMetadata: metadata, model: metadata.id, family: metadata.capabilities.family,
        url, supportsReasoningEffort: metadata.capabilities.supports.reasoning_effort, _configurationService: { getConfig: () => undefined } });
    } }
  };
  var renderer = { ${renderRound} };
`, context, { timeout: 5000 });

const result = await vm.runInContext(`(async () => {
  const modelId = 'deepseek-v4-pro';
  const profile = { id: modelId, apiType: 'chat-completions', url: 'https://api.deepseek.com/v1/chat/completions',
    thinking: true, supportsReasoningEffort: ['low', 'high', 'max'], reasoningEffortFormat: 'chat-completions' };
  async function endpointFor(entry) {
    return provider.createOpenAIEndPoint({ id: entry.id, name: entry.id, url: entry.url, maxOutputTokens: 4096, maxInputTokens: 10000,
      capabilities: { toolCalling: true }, configuration: { models: [entry] } });
  }
  const endpoint = await endpointFor(profile);
  assert.equal(endpoint.url, profile.url);
  assert(!endpoint.useResponsesApi && !endpoint.useMessagesApi);
  assert.equal(endpoint.modelMetadata.capabilities.supports.tool_calls, true);
  const aggregate = await endpointFor({ ...profile, id: 'local-deepseek', url: 'http://127.0.0.1:18181/tool/vscode/v1/chat/completions' });
  assert.equal(aggregate.url, 'http://127.0.0.1:18181/tool/vscode/v1/chat/completions');
  assert(!aggregate.useResponsesApi && !aggregate.useMessagesApi);

  let thought;
  for (const text of ['SYNTHETIC ', 'reasoning']) {
    thought = a5e.createOrUpdate(thought, Qkn({ delta: { reasoning_content: text } }));
  }
  assert.equal(thought.text, 'SYNTHETIC reasoning');
  const call = { id: 'fixture-call', name: 'lookup', arguments: '{}' };
  function roundMessage(thinking, { currentTask = true, sourceModel = modelId, callName = call.name } = {}) {
    const round = { modelId: sourceModel, originApi: 'chatCompletions', response: '', thinking,
      toolCalls: [{ ...call, name: callName }] };
    const tree = renderer.renderOneToolCallRound.call({
      props: { isHistorical: true, isCurrentTask: currentTask, toolCallResults: { 'fixture-call': {} }, promptContext: { tools: {} } },
      promptEndpoint: { model: modelId, apiType: 'chatCompletions', supportsThinkingContentInHistory: hqe(endpoint) },
      toolsService: { validateToolName: name => name }
    }, round, 0, 1, { invokeFunction: () => undefined }, {}, null);
    const assistant = tree.find(node => node.ctor === 'assistant');
    const content = [];
    for (const node of assistant.children) {
      if (node?.ctor === Zne) {
        const opaque = Zne.prototype.render.call({ props: node.props });
        content.push({ type: opaque.ctor, value: opaque.props.value });
      }
    }
    return { role: eD.ChatRole.Assistant, content, toolCalls: assistant.props.toolCalls };
  }
  const messages = [
    { role: eD.ChatRole.User, content: [{ type: 'text', text: 'Synthetic lookup' }] },
    roundMessage(thought),
    { role: eD.ChatRole.Tool, toolCallId: call.id, content: [{ type: 'text', text: 'Synthetic tool result' }] },
  ];
  // Exercise the two installed adapters on either side of the VS Code language
  // model API. JSX flattening and VS Code value classes are the fixture seams.
  const languageMessages = lpn([messages[1]]);
  const prompt = await jre.prototype.render.call({ props: { messages: languageMessages, noSafety: true } });
  const assistant = prompt.children[1][0];
  const thinkingNode = assistant.children.flat(2).find(part => part?.ctor === Zne);
  assert(thinkingNode, 'The contributed endpoint must receive the original model thinking.');
  const opaque = Zne.prototype.render.call({ props: thinkingNode.props });
  messages[1] = { role: eD.ChatRole.Assistant, toolCalls: assistant.props.toolCalls,
    content: [{ type: opaque.ctor, value: opaque.props.value }, { type: 'text', text: assistant.children[1] }] };
  const tools = [{ type: 'function', function: { name: call.name, parameters: { type: 'object', properties: {} } } }];
  for (const effort of profile.supportsReasoningEffort) {
    const body = endpoint.createRequestBody({ messages, postOptions: { stream: true, tools }, modelCapabilities: { reasoningEffort: effort } });
    assert.equal(body.model, modelId);
    assert.equal(body.stream, true);
    assert.equal(body.reasoning_effort, effort);
    assert(!body.reasoning && !body.output_config && !('input' in body));
    assert.equal(body.tools[0].function.name, call.name);
    assert.equal(body.messages[1].reasoning_content, thought.text);
    assert.equal(body.messages[1].tool_calls[0].function.name, call.name);
    assert.equal(body.messages[2].tool_call_id, call.id);
    assert.equal(body.messages[2].content, 'Synthetic tool result');
  }

  // A renderer-originated tool callback can have no model thinking attached.
  // The client does not reconstruct reasoning for that or another model/task.
  for (const message of [roundMessage(undefined, { callName: 'read_bash' }),
    roundMessage(thought, { sourceModel: 'another-model' }), roundMessage(thought, { currentTask: false })]) {
    const body = endpoint.createRequestBody({ messages: [message] });
    assert(!('reasoning_content' in body.messages[0]));
  }
  const disabled = await endpointFor({ ...profile, supportsReasoningEffort: ['none'],
    modelOptions: { thinking: { type: 'disabled' } } });
  const body = disabled.createRequestBody({ messages, modelCapabilities: { reasoningEffort: 'none' } });
  assert.equal(body.reasoning_effort, 'none');
  assert(!('thinking' in body));
  assert.equal(body.messages[1].reasoning_content, thought.text);
  return { directAndAggregateChatEndpoints: true, chatEffortAndToolFields: true,
    streamedReasoningAndCurrentTaskHistory: true, languageModelApiRoundTripVerified: true, missingAndCrossTaskThinkingOmitted: true,
    noneUsesTopLevelEffort: true };
})()`, context, { timeout: 5000 });

console.log(JSON.stringify({
  copilotVersion: manifest.version, bundleSha256: createHash('sha256').update(bundle).digest('hex'),
  checks: result, scope: 'Extracted installed-client code with fixture JSX, dependency injection and settings. No native GUI or upstream inference.',
}, null, 2));
