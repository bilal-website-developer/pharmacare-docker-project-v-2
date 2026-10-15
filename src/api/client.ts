import { getBackend } from './config';

type ApiErrorBody = {
  error?: unknown;
  message?: unknown;
};

const ERROR_MESSAGES: Record<string, string> = {
  API_UNAVAILABLE: 'Could not connect to the application server. Please try again.',
  CUSTOMER_NOT_FOUND: 'The selected customer is no longer available.',
  DISCOUNT_EXCEEDS_ROLE_LIMIT: 'The discount exceeds your permitted limit.',
  DUPLICATE_VALUE: 'A record with these details already exists.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  INSUFFICIENT_STOCK: 'There is not enough sellable stock to complete this action.',
  INVALID_CREDENTIALS: 'Invalid sign-in details.',
  NOT_FOUND: 'The requested record could not be found.',
  PAYMENTS_MUST_EQUAL_TOTAL: 'Payment amounts must match the bill total.',
  PRESCRIPTION_REQUIRED: 'Prescription details are required for this medicine.',
  RATE_LIMITED: 'Too many sign-in attempts. Please wait and try again.',
  SESSION_EXPIRED: 'Your session has expired. Sign in again.',
  UNAUTHENTICATED: 'Your session has expired. Sign in again.',
  VALIDATION_FAILED: 'Some submitted information is invalid. Check it and try again.',
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = ERROR_MESSAGES[code] ?? 'The request could not be completed.',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;

export function setApiAccessToken(token: string): void {
  accessToken = token;
}

export function clearApiAccessToken(): void {
  accessToken = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError('INVALID_RESPONSE', response.status, 'The application server returned an invalid response.');
  }
}

function apiError(response: Response, payload: unknown): ApiError {
  const body = isRecord(payload) ? payload as ApiErrorBody : {};
  const code = typeof body.error === 'string' ? body.error : 'REQUEST_FAILED';
  const safeMessage = ERROR_MESSAGES[code];
  return new ApiError(code, response.status, safeMessage);
}

async function send(
  path: string,
  init: RequestInit,
  token: string | null,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  try {
    return await fetch(path, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch {
    throw new ApiError('API_UNAVAILABLE', 0);
  }
}

function readAccessToken(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.accessToken !== 'string' || !payload.accessToken) return null;
  return payload.accessToken;
}

async function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const response = await send('/api/auth/refresh', { method: 'POST' }, null);
    const payload = await readJson(response);
    if (!response.ok) {
      clearApiAccessToken();
      if (response.status === 401) return null;
      throw apiError(response, payload);
    }
    const token = readAccessToken(payload);
    if (!token) {
      clearApiAccessToken();
      throw new ApiError('INVALID_RESPONSE', response.status, 'The application server returned an invalid session.');
    }
    setApiAccessToken(token);
    return token;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export async function restoreApiAccessToken(): Promise<boolean> {
  return Boolean(await refreshAccessToken());
}

function notifySessionExpired(): void {
  clearApiAccessToken();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('pharma-care:api-session-expired'));
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (getBackend() !== 'api') {
    throw new ApiError('BACKEND_MISMATCH', 0, 'The API client is unavailable when VITE_BACKEND=supabase.');
  }

  let response = await send(path, init, accessToken);
  let payload = await readJson(response);

  if (response.status === 401 && path !== '/api/auth/login') {
    let token: string | null;
    try {
      token = await refreshAccessToken();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('API_UNAVAILABLE', 0);
    }
    if (!token) {
      notifySessionExpired();
      throw new ApiError('SESSION_EXPIRED', 401);
    }
    response = await send(path, init, token);
    payload = await readJson(response);
    if (response.status === 401) {
      notifySessionExpired();
      throw new ApiError('SESSION_EXPIRED', 401);
    }
  }

  if (!response.ok) throw apiError(response, payload);
  return payload as T;
}

export function isUnauthenticatedApiError(error: unknown): boolean {
  return error instanceof ApiError
    && (error.status === 401 || error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED');
}
