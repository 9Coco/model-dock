import { isObject, type Json } from './gateway-sse';

// Copilot Agent Host inserts terminal and agent notification callbacks as
// function calls with local UUIDs. They have no model-authored reasoning.
const callbackNames = new Set(['read_bash', 'read_powershell', 'read_agent']);
const localCallId = /^(?:call_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function prepareVsCodeDeepSeekChat(body: Json, defaultEffort: string | undefined): Json {
  const disabled = defaultEffort === 'none';
  const effort = disabled ? 'none' : body.reasoning_effort ?? defaultEffort;
  const result: Json = { ...body, reasoning_effort: effort };
  // The explicit thinking switch takes precedence over reasoning_effort at DeepSeek.
  if (disabled && isObject(body.thinking)) result.thinking = { ...body.thinking, type: 'disabled' };
  const thinking = isObject(result.thinking) ? result.thinking.type === 'enabled' : effort !== 'none';
  if (!thinking || !Array.isArray(body.messages)) return result;
  const results = new Set(body.messages.filter(message => isObject(message) && message.role === 'tool').map(message => message.tool_call_id));
  result.messages = body.messages.map(message => {
    if (!isObject(message) || message.role !== 'assistant' || message.reasoning_content != null && message.reasoning_content !== ''
      || !Array.isArray(message.tool_calls) || !message.tool_calls.length) return message;
    const localCallbacks = message.tool_calls.every(call => isObject(call) && call.type === 'function'
      && isObject(call.function) && callbackNames.has(String(call.function.name))
      && typeof call.id === 'string' && localCallId.test(call.id) && results.has(call.id));
    // A synthetic callback has no model-authored reasoning to replay.
    return localCallbacks ? { ...message, reasoning_content: ' ' } : message;
  });
  return result;
}

export function prepareVsCodeDeepSeekResponses(body: Json, defaultEffort: string | undefined): Json {
  const reasoning = isObject(body.reasoning) ? body.reasoning : {};
  const effort = defaultEffort === 'none' ? 'none' : reasoning.effort ?? defaultEffort;
  const result = { ...body, reasoning: { ...reasoning, effort } };
  if (effort === 'none' || !Array.isArray(body.input)) return result;
  const tools = new Set(body.input.filter(item => isObject(item) && item.type === 'function_call_output').map(item => item.call_id));
  const input: unknown[] = [];
  let hasPlainReasoning = false;
  for (const item of body.input) {
    if (isObject(item)) {
      if (item.type === 'reasoning') {
        hasPlainReasoning ||= Array.isArray(item.content) && item.content.some(part =>
          isObject(part) && part.type === 'reasoning_text' && typeof part.text === 'string' && part.text.length > 0);
      } else if (item.type === 'function_call' && typeof item.call_id === 'string' && callbackNames.has(String(item.name))
        && localCallId.test(item.call_id) && tools.has(item.call_id) && !hasPlainReasoning) {
        // DeepSeek rejects an empty string; one space represents a callback
        // with no model thinking. Preserve all real reasoning items.
        input.push({ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: ' ' }] });
        hasPlainReasoning = true;
      } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output'
        || (item.role === 'user' || item.role === 'system' || item.role === 'developer')) hasPlainReasoning = false;
    }
    input.push(item);
  }
  return { ...result, input };
}

/** Copilot renders the standard reasoning summary delta but ignores DeepSeek's
 * plaintext reasoning delta. The native reasoning item and opaque ID remain
 * intact for subsequent requests. */
export function vsCodeDeepSeekReasoningEvent(data: Json): Json {
  return data.type === 'response.reasoning_text.delta'
    ? { ...data, type: 'response.reasoning_summary_text.delta', summary_index: 0 }
    : data;
}
