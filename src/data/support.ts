import { apiRequest } from '../api';

export type SupportScope = 'diagnostics' | 'read_only' | 'admin_actions';

export interface SupportSessionSummary {
  sessionId: string;
  scope: SupportScope;
  expiresAt: string;
  startedAt: string | null;
}

export interface SupportApproval {
  sessionId: string;
  code: string;
  scope: SupportScope;
  expiresAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportScope(value: unknown): value is SupportScope {
  return value === 'diagnostics' || value === 'read_only' || value === 'admin_actions';
}

function parseSession(value: unknown): SupportSessionSummary {
  if (!isRecord(value)
    || typeof value.sessionId !== 'string'
    || !/^[a-f\d]{24}$/i.test(value.sessionId)
    || !isSupportScope(value.scope)
    || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt))
    || !(value.startedAt === null
      || (typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))))) {
    throw new Error('The support session service returned an invalid session.');
  }
  return {
    sessionId: value.sessionId,
    scope: value.scope,
    expiresAt: value.expiresAt,
    startedAt: value.startedAt,
  };
}

export async function loadSupportSessions(): Promise<SupportSessionSummary[]> {
  const value: unknown = await apiRequest('/api/support/sessions');
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    throw new Error('The support session service returned an invalid response.');
  }
  return value.sessions.map(parseSession);
}

export async function allowSupport(scope: SupportScope): Promise<SupportApproval> {
  const value: unknown = await apiRequest('/api/support/allow', {
    method: 'POST',
    body: JSON.stringify({ scope }),
  });
  if (!isRecord(value)
    || typeof value.sessionId !== 'string'
    || !/^[a-f\d]{24}$/i.test(value.sessionId)
    || typeof value.code !== 'string'
    || !/^\d{6}$/.test(value.code)
    || !isSupportScope(value.scope)
    || value.scope !== scope
    || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new Error('The support approval service returned an invalid response.');
  }
  return {
    sessionId: value.sessionId,
    code: value.code,
    scope: value.scope,
    expiresAt: value.expiresAt,
  };
}

export async function endSupportSession(sessionId: string): Promise<void> {
  const value: unknown = await apiRequest('/api/support/end', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
  if (!isRecord(value) || Object.keys(value).length !== 1 || value.ended !== true) {
    throw new Error('The support session could not be ended.');
  }
}
