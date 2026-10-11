type Json = Record<string, unknown>;

export type NativeMessagesErrorType = 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error'
  | 'request_too_large' | 'rate_limit_error' | 'api_error' | 'overloaded_error' | 'timeout_error';

export interface NormalizedNativeMessagesError { type: NativeMessagesErrorType; message: string; status: number }

const errors: Record<NativeMessagesErrorType, { status: number; message: string }> = {
  invalid_request_error: { status: 400, message: '上游拒绝 Messages 请求参数，请检查模型、历史消息和工具定义。' },
  authentication_error: { status: 401, message: '上游 Messages 身份验证失败，请检查供应商凭据。' },
  permission_error: { status: 403, message: '上游拒绝 Messages 请求权限，请检查模型授权。' },
  not_found_error: { status: 404, message: '上游 Messages 接口或模型不存在。' },
  request_too_large: { status: 413, message: '上游 Messages 请求过大，请缩短历史消息或工具定义。' },
  rate_limit_error: { status: 429, message: '上游 Messages 请求达到速率限制，请稍后重试。' },
  api_error: { status: 502, message: '上游 Messages 推理失败或响应不完整，请检查模型和供应商状态。' },
  overloaded_error: { status: 529, message: '上游 Messages 服务暂时过载，请稍后重试。' },
  timeout_error: { status: 504, message: '上游 Messages 请求超时，请稍后重试。' },
};

const httpTypes = new Map<number, NativeMessagesErrorType>([
  [400, 'invalid_request_error'], [401, 'authentication_error'], [403, 'permission_error'], [404, 'not_found_error'],
  [413, 'request_too_large'], [429, 'rate_limit_error'], [504, 'timeout_error'], [529, 'overloaded_error'],
]);
const parameterMessages = new Map<string, string>([
  ['messages.tool_calls.type', '上游 Messages 兼容接口拒绝工具调用参数（messages.tool_calls.type）：工具调用类型必须为 function。'],
]);
const fixedParameterMessages = new Set(parameterMessages.values());

function object(value: unknown): value is Json { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function knownType(value: unknown): value is NativeMessagesErrorType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(errors, value);
}

/** Error bodies can echo credentials and requests. Only closed categories and exact
 * known parameter names select fixed local messages; upstream text never escapes.
 * An HTTP status may supply transport semantics, but an unrecognized SSE error
 * without that status stays api_error and cannot masquerade as a valid response.
 */
export function normalizeNativeMessagesError(value: unknown, fallbackStatus?: number): NormalizedNativeMessagesError {
  const raw = object(value) && (value.type === undefined || value.type === 'error') && object(value.error)
    && typeof value.error.message === 'string' ? value.error : undefined;
  let type: NativeMessagesErrorType = httpTypes.get(fallbackStatus ?? 0) ?? 'api_error';
  if (raw && knownType(raw.type)) type = raw.type;
  // Observed Volcengine Messages SSE shape; do not infer categories from arbitrary text.
  else if (raw?.type === 'BadRequest' && raw.code === 'InvalidParameter') type = 'invalid_request_error';
  const definition = errors[type];
  // A collected SSE error is already normalized. Exact fixed-message equality
  // keeps normalization idempotent without permitting any upstream text echo.
  const parameterMessage = type === 'invalid_request_error' && raw
    ? (typeof raw.param === 'string' ? parameterMessages.get(raw.param) : undefined)
      ?? (typeof raw.message === 'string' && fixedParameterMessages.has(raw.message) ? raw.message : undefined)
    : undefined;
  return { type, status: definition.status, message: parameterMessage ?? definition.message };
}
