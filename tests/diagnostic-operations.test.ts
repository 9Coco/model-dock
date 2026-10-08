import { describe, expect, it } from 'vitest';
import { diagnosticOperationContext, diagnosticOperationResult, ignoresDiagnosticOperation, isQuietDiagnosticOperation } from '../src/main/diagnostic-operations';

const providerId = 'a16de6b3-6c58-49ba-988c-0ab1c438b90b';
const modelId = '0ea1b7c2-b4d4-4c17-83c1-aa4c1bb56bb7';
const secret = 'PRIVATE_TOKEN_PROMPT_BODY_DO_NOT_LOG';
describe('diagnostic operation classification excludes all credential and body fields', () => {
  it('records returned inference failures with HTTP and saved model identity, without returned text or credentials', () => {
    const value = diagnosticOperationResult('testProvider', [providerId, { modelId, apiKey: secret }], { ok: false, outcome: 'invalid-response', statusCode: 200, wireApi: 'responses', message: secret, testedModel: secret, response: secret }, 12.3);
    expect(value).toMatchObject({ level: 'warn', event: 'connection.result', context: { providerId, modelId, statusCode: 200, outcome: 'invalid-response', wireApi: 'responses', durationMs: 12 } });
    expect(JSON.stringify(value)).not.toContain(secret);
  });
  it('records unsupported model catalog separately from actual connection testing', () => {
    expect(diagnosticOperationResult('discoverModels', [providerId], { ok: false, errorCategory: 'unsupported', statusCode: 404, message: secret, models: [] }, 5)).toMatchObject({ level: 'warn', event: 'models.discovery', context: { outcome: 'unsupported', statusCode: 404, modelCount: 0 } });
  });
  it('records only recognized auth stages and categories, never user codes, verification URLs or tokens', () => {
    const value = diagnosticOperationResult('authProgress', [providerId], { providerId, state: 'error', stage: 'token-exchange', category: 'authentication', statusCode: 401, userCode: secret, verificationUri: `https://example.test/?token=${secret}`, message: secret, accessToken: secret }, 8);
    expect(value).toMatchObject({ event: 'auth.progress', level: 'warn', context: { stage: 'token-exchange', outcome: 'authentication' } });
    expect(JSON.stringify(value)).not.toContain(secret);
    expect(diagnosticOperationResult('authProgress', [providerId], { providerId, state: 'pending', stage: secret }, 1)?.context.stage).toBeUndefined();
  });
  it('distinguishes quota stale/error results from Promise success', () => {
    expect(diagnosticOperationResult('refreshAccountUsage', ['copilot:42'], { usage: { status: 'stale', message: secret, windows: [{ token: secret }] } }, 2)).toMatchObject({ level: 'warn', event: 'account.refresh', context: { outcome: 'stale' } });
  });
  it('ignores diagnostic queries, exports and credential copy operations to prevent loops', () => {
    for (const name of ['queryDiagnostics', 'diagnosticsText', 'exportDiagnostics', 'openDiagnosticsDir', 'copyText', 'copyGatewayKey', 'copyConnectionKey'] as const) {
      expect(ignoresDiagnosticOperation(name)).toBe(true);
      expect(diagnosticOperationResult(name, [secret], secret, 2)).toBeUndefined();
    }
    expect(isQuietDiagnosticOperation('snapshot')).toBe(true);
    expect(diagnosticOperationResult('snapshot', [], { providers: [{ apiKey: secret }] }, 2)).toBeUndefined();
  });
  it('never incorporates unvalidated object identifiers or upstream configuration', () => {
    expect(diagnosticOperationContext('saveProvider', [{ id: secret, name: secret, baseUrl: `https://${secret}.example.test`, apiKey: secret }])).toEqual({ operation: 'saveProvider', providerId: undefined });
    expect(diagnosticOperationResult('applyConfig', ['opencode'], { filename: secret, content: secret }, 4)).toMatchObject({ event: 'config.apply', context: { toolId: 'opencode', outcome: 'success' } });
  });
});
