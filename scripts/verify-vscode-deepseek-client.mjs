/**
 * Offline probe of the installed Copilot implementation, using synthetic data.
 *
 * Usage: node scripts/verify-vscode-deepseek-client.mjs --extension-dir <copilot-dir>
 * The directory must contain package.json and dist/extension.js. The probe reads
 * only those two files and evaluates extracted functions in a restricted VM.
 * It does not load the extension, read settings/credentials, or make requests.
 *
 * This deliberately supports the inspected 0.75.0 bundle only. A changed bundle
 * must be reviewed before changing the extraction markers or supported version.
 * VS Code API value classes, prompt JSX construction and unrelated services are
 * fixture seams; reasoning capture, retention and serialization use real code.
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

const extensionDir = resolve(args[1]);
const manifest = JSON.parse(readFileSync(join(extensionDir, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'copilot-chat', 'The supplied directory is not the Copilot Chat extension.');
assert.equal(manifest.version, '0.75.0', 'Unreviewed Copilot version: review the installed implementation before updating this probe.');
const source = readFileSync(join(extensionDir, 'dist', 'extension.js'), 'utf8');

function extract(start, end) {
  const first = source.indexOf(start);
  assert(first >= 0, `Unsupported bundle: missing ${start}`);
  assert.equal(source.indexOf(start, first + start.length), -1, `Ambiguous bundle marker: ${start}`);
  const last = source.indexOf(end, first + start.length);
  assert(last > first, `Unsupported bundle: missing end marker ${end}`);
  return source.slice(first, last);
}

const kinds = { Text: 'text', Opaque: 'opaque', Image: 'image', CacheBreakpoint: 'cache', Document: 'document' };
const roles = { System: 'system', User: 'user', Assistant: 'assistant', Tool: 'tool' };
class TextPart { constructor(value) { this.value = value; } }
class ThinkingPart {
  constructor(value, id, metadata = {}) { Object.assign(this, { value, id, metadata }); }
}
class DataPart { constructor(data, mimeType) { Object.assign(this, { data, mimeType }); } }
class ToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
class ToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
const api = {
  LanguageModelTextPart: TextPart, LanguageModelThinkingPart: ThinkingPart, LanguageModelDataPart: DataPart,
  LanguageModelToolCallPart: ToolCallPart, LanguageModelToolResultPart2: ToolResultPart,
  LanguageModelToolResultPart: ToolResultPart, LanguageModelChatMessageRole: roles,
};
const rawApi = { Raw: { ChatRole: roles, ChatCompletionContentPartKind: kinds } };
const context = {
  assert, Buffer, TextEncoder,
  gt: () => 'synthetic-reasoning-id',
  Xa: { ThinkingData: 'thinking' },
  vo: api, cm: api, Dg: api, cDn: api, cL: rawApi, b0: rawApi,
  Pl: { AssistantMessage: 'assistant', UserMessage: 'user', useKeepWith: () => 'keep' },
  xT: { PromptElement: class {}, AssistantMessage: 'assistant', SystemMessage: 'system', UserMessage: 'user', ToolMessage: 'tool' },
  vscpp: (ctor, props, ...children) => ({ ctor, props, children }),
  vscppf: 'fragment', Vne: 'thinking', nre: 'stateful', w$e: 'phase', v$e: 'compaction',
  VLi: 'tool', W5e: value => value, tEe: 'missing', ZLi: 5, sn: { None: null },
  nEe: () => undefined, k_: 'tool-result', _T: () => false,
  ge: 'config', We: 'experiments', __: 'deferral', X: 'log', Re: 'telemetry', Ro: 'tool_search',
  H: { Advanced: { ReasoningEffortOverride: 'effortOverride' } },
  K8e: () => false, hkn: () => false, sxt: value => value,
};
vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });

const functions = [
  extract('function l9(', 'var Wb='),
  extract('function qwe(', 'function $we('),
  `${extract('var i5e=class', ';var Rg=')};`,
  `${extract('var Hwe=class', ';Hwe=D')};`,
  extract('function iMi(', 'var Gre='),
  `${extract('var Gre=class', ';var zh=')};`,
  extract('function rpn(', 'cr();Ve();ze();var P9a='),
  extract('function KTi(', 'async function Nkn('),
];
const renderRound = extract('renderOneToolCallRound(n,r,o,a,s,c){', '};ol=D');
const responseWrapper = extract('async provideLanguageModelResponse(n,r,o,a,s,c){', 'async provideTokenCount(n,r)');
const effortAndOptions = extract('_applyConfiguredModelOptions(n,r){', 'interceptBody(n)');
const openAiRequestBody = extract('createRequestBody(n){if(this.useResponsesApi){', '_applyConfiguredModelOptions(n,r)');
const customRequestBody = extract('get supportsStatefulResponses(){return this.modelMetadata.statefulResponses!==!1}', '_isReservedHeader(e)');

vm.runInContext(`${functions.join('\n')}
var roundRenderer = { ${renderRound} };
var nativeWrapper = { ${responseWrapper} };
class FixtureEffortSetter { ${effortAndOptions} }
var effortSetter = new FixtureEffortSetter();
// The base Responses body is a seam: assert the real adapter requests full
// history, then leave unrelated Responses input serialization outside this probe.
class FixtureResponsesBase {
  createRequestBody(request) {
    assert.equal(request.ignoreStatefulMarker, true);
    return { input: request.messages, reasoning: { effort: 'medium' },
      include: ['reasoning.encrypted_content'], truncation: 'disabled', store: false };
  }
}
class FixtureOpenAIEndpoint extends FixtureResponsesBase { ${openAiRequestBody} ${effortAndOptions} }
class FixtureCustomEndpoint extends FixtureOpenAIEndpoint { ${customRequestBody} }
`, context, { timeout: 5000 });

const result = await vm.runInContext(`(async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SYNTHETIC first ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
    { type: 'content_block_stop', index: 0 },
  ];
  const parts = [];
  await nativeWrapper.provideLanguageModelResponse.call({
    _provideLanguageModelResponse: async (_n, _r, _o, _a, callback) => {
      const parser = new Hwe({}, 'fixture-request', '', '', '', { trace() {}, warn() {} });
      for (const event of events) parser.push(event, callback);
    },
    _logService: { error() {} },
  }, { apiType: 'messages' }, [], { includeEncryptedThinking: true }, undefined,
  { report: part => parts.push(part) }, undefined);
  assert(parts.some(part => part.metadata?.encrypted_content === 'fixture-signature'));

  // This is the LanguageModelThinkingPart -> tool-loop accumulation seam used
  // by the extension-contributed endpoint; the accumulator itself is original.
  let saved;
  for (const part of parts) if (part instanceof vo.LanguageModelThinkingPart) {
    saved = i5e.createOrUpdate(saved, { text: part.value, id: part.id || '', metadata: part.metadata });
  }
  assert.equal(saved.text, 'SYNTHETIC first reasoning');
  assert.equal(saved.metadata.encrypted_content, 'fixture-signature');

  const raw = [];
  for (const withTool of [true, false]) {
    const round = {
      modelId: 'deepseek-flash', originApi: 'messages', thinking: saved,
      response: withTool ? '' : 'SYNTHETIC final',
      toolCalls: withTool ? [{ id: 'fixture_tool', name: 'lookup', arguments: '{}' }] : [],
    };
    const renderer = {
      props: { isHistorical: true, isCurrentTask: false,
        toolCallResults: { fixture_tool: { value: 'result' } }, promptContext: { tools: {} } },
      promptEndpoint: { model: 'deepseek-flash', apiType: 'messages', supportsAdaptiveThinking: true },
      toolsService: { validateToolName: name => name },
    };
    const tree = roundRenderer.renderOneToolCallRound.call(renderer, round, 0, 1,
      { invokeFunction: () => undefined }, {}, null);
    const assistant = tree.find(node => node.ctor === 'assistant');
    const thinking = assistant.children.find(node => node?.ctor === 'thinking');
    assert(thinking, 'Historical thinking must remain in both tool and final assistant rounds.');
    raw.push({ role: 'assistant', content: [
      { type: 'opaque', value: { type: 'thinking', thinking: thinking.props.thinking, originApi: 'messages' } },
      { type: 'text', text: round.response },
    ], toolCalls: assistant.props.toolCalls });
    if (withTool) raw.push({ role: 'tool', toolCallId: 'fixture_tool',
      content: [{ type: 'text', text: 'SYNTHETIC tool result' }] });

    renderer.promptEndpoint.supportsAdaptiveThinking = false;
    const withoutAdaptive = roundRenderer.renderOneToolCallRound.call(renderer, round, 0, 1,
      { invokeFunction: () => undefined }, {}, null);
    assert(!withoutAdaptive.find(node => node.ctor === 'assistant').children.some(node => node?.ctor === 'thinking'));
    renderer.promptEndpoint.supportsAdaptiveThinking = true;
    renderer.promptEndpoint.model = 'another-model';
    const otherModel = roundRenderer.renderOneToolCallRound.call(renderer, round, 0, 1,
      { invokeFunction: () => undefined }, {}, null);
    assert(!otherModel.find(node => node.ctor === 'assistant').children.some(node => node?.ctor === 'thinking'));
  }
  raw.push({ role: 'user', content: [{ type: 'text', text: 'SYNTHETIC next user turn' }] });

  const apiMessages = rpn(raw);
  const promptTree = await Gre.prototype.render.call({ props: { messages: apiMessages, noSafety: true } });
  const nativeRaw = [];
  for (const message of promptTree.children[1]) {
    if (message.ctor === 'assistant') {
      const thinking = message.children.flat(2).find(part => part?.ctor === 'thinking');
      assert.equal(thinking.props.thinking.encrypted, 'fixture-signature');
      nativeRaw.push({ role: 'assistant', toolCalls: message.props.toolCalls, content: [
        { type: 'opaque', value: { type: 'thinking', thinking: thinking.props.thinking } },
        { type: 'text', text: message.children[1] },
      ] });
    } else if (message.ctor === 'tool') {
      nativeRaw.push({ role: 'tool', toolCallId: message.props.toolCallId,
        content: [{ type: 'text', text: 'SYNTHETIC tool result' }] });
    } else if (message.ctor === 'user') {
      nativeRaw.push({ role: 'user', content: [{ type: 'text', text: message.children[0] }] });
    }
  }
  const request = { messages: nativeRaw, postOptions: { max_tokens: 4096 }, requestOptions: { tools: [
    { type: 'function', function: { name: 'lookup', description: 'Fixture', parameters: { type: 'object', properties: {} } } },
  ] } };
  const endpoint = { model: 'deepseek-flash', supportsAdaptiveThinking: true, supportsReasoningEffort: ['low', 'high', 'max'] };
  const config = { getConfig: () => undefined };
  const services = { get: key => key === 'config' ? config : key === 'log' ? { warn() {} }
    : key === 'telemetry' ? { sendMSFTTelemetryEvent() {} } : {} };

  for (const level of ['low', 'high', 'max']) {
    const body = Pkn(services, { ...request, modelCapabilities: { enableThinking: true, reasoningEffort: level } },
      'deepseek-flash', endpoint);
    effortSetter._applyReasoningEffort.call({ ...endpoint, modelMetadata: { reasoningEffortFormat: 'messages' },
      useMessagesApi: true, _configurationService: config }, body, { modelCapabilities: { reasoningEffort: level } });
    assert.equal(body.thinking.type, 'adaptive');
    assert.equal(body.output_config.effort, level);
    const assistants = body.messages.filter(message => message.role === 'assistant');
    assert.equal(assistants.length, 2);
    for (const assistant of assistants) {
      const thinking = assistant.content.find(part => part.type === 'thinking');
      assert.equal(thinking.signature, 'fixture-signature');
      assert.equal(thinking.thinking, 'SYNTHETIC first reasoning');
    }
  }

  // Use the same stateless Responses adapter that the generated profiles use.
  const responseEfforts = ['none', 'low', 'high', 'max'];
  const responses = Object.assign(new FixtureCustomEndpoint(), {
    useResponsesApi: true, useMessagesApi: false, supportsReasoningEffort: responseEfforts,
    _configurationService: config,
    modelMetadata: { capabilities: { supports: { thinking: true } },
      reasoningEffortFormat: 'responses', statefulResponses: false },
  });
  for (const effort of responseEfforts) {
    const request = { messages: [{ role: 'user', content: 'SYNTHETIC request' }],
      modelCapabilities: { reasoningEffort: effort } };
    const body = responses.createRequestBody(request);
    assert.equal(body.reasoning.effort, effort);
    assert.equal(request.ignoreStatefulMarker, true);
    assert.equal(body.input, request.messages);
    assert(!('store' in body));
    assert(!('truncation' in body));
  }

  const optionProbe = {};
  effortSetter._applyConfiguredModelOptions.call({ modelMetadata: { modelOptions: { thinking: { type: 'disabled' } } } },
    optionProbe, {});
  assert.equal(optionProbe.thinking, undefined, 'Unknown modelOptions fields are ignored by the actual client.');

  return {
    splitThinkingAndSignatureStreamCaptured: true,
    signaturePassedThroughLanguageModelAPI: true,
    historicalToolAndFinalRoundsPreserved: true,
    adaptiveHistoryAndModelBoundariesVerified: true,
    fullNextUserRequestPreservesSignedThinking: true,
    adaptiveThinkingAndAllEffortsSerialized: true,
    officialResponsesEffortsAndStatelessRequestSerialized: true,
    unknownThinkingModelOptionIgnored: true,
  };
})()`, context, { timeout: 5000 });

console.log(JSON.stringify({
  copilotVersion: manifest.version,
  bundleSha256: createHash('sha256').update(source).digest('hex'),
  checks: result,
  scope: 'Offline extracted installed-client code with VS Code value classes, prompt rendering and unrelated services stubbed. The stateless Responses test stubs the base Responses body. No native GUI, network or upstream acceptance test.',
}, null, 2));
