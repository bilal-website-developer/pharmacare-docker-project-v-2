import { getBackend } from './config';

type ApiErrorBody = {
  error?: unknown;
  message?: unknown;
  fields?: unknown;
};

const ERROR_MESSAGES: Record<string, string> = {
  API_UNAVAILABLE: 'Could not connect to the application server. Please try again.',
  CUSTOMER_NOT_FOUND: 'The selected customer is no longer available.',
  DISCOUNT_EXCEEDS_ROLE_LIMIT: 'The discount exceeds your permitted limit.',
  DUPLICATE_VALUE: 'A record with these details already exists.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  INSUFFICIENT_STOCK: 'There is not enough sellable stock to complete this action.',
  INVALID_CREDENTIALS: 'Invalid sign-in details.',
  INVALID_CURRENT_PASSWORD: 'The current password is incorrect.',
  LICENCE_UNAVAILABLE: 'Licence status could not be verified. Contact the shop administrator.',
  NOT_FOUND: 'The requested record could not be found.',
  PAYMENTS_MUST_EQUAL_TOTAL: 'Payment amounts must match the bill total.',
  PRESCRIPTION_REQUIRED: 'Prescription details are required for this medicine.',
  ACTIVE_MEDICINE_AND_UNIT_REQUIRED: 'The selected product or unit is no longer available.',
  ACTIVE_SUPPLIER_REQUIRED: 'Select an active supplier.',
  BATCH_STATUS_NOT_ADJUSTABLE: 'This stock batch cannot be adjusted in its current status.',
  BATCH_CHANGED_CONCURRENTLY: 'Stock changed while the adjustment was being saved. Refresh and try again.',
  BATCH_NOT_EXPIRED: 'Only expired stock can be written off.',
  BATCH_HAS_NO_REMAINING_STOCK: 'This batch has no remaining stock to write off.',
  DISCOUNT_EXCEEDS_SUBTOTAL: 'Purchase discount cannot exceed its subtotal.',
  EXPIRY_NOT_AFTER_PURCHASE_DATE: 'Batch expiry must be after the purchase date.',
  EXPORT_LIMIT_EXCEEDED: 'The filtered purchase export exceeds the 100,000-record limit.',
  INVALID_UNIT_CONVERSION: 'The selected purchase unit has an invalid conversion.',
  PURCHASE_CHANGED_CONCURRENTLY: 'This purchase changed. Refresh the history and try again.',
  PURCHASE_STOCK_ALREADY_CHANGED: 'This purchase can no longer be voided because its stock changed.',
  PURCHASE_STOCK_CHANGED_CONCURRENTLY: 'Stock changed while the purchase was being saved. Refresh and try again.',
  PURCHASE_TOTAL_LIMIT_EXCEEDED: 'The purchase total exceeds the supported amount.',
  QUANTITY_LIMIT_EXCEEDED: 'The purchase quantity exceeds the supported limit.',
  RATE_LIMITED: 'Too many sign-in attempts. Please wait and try again.',
  RETURN_ALREADY_PROCESSED: 'This return request has already been decided or processed.',
  RETURN_QUANTITY_EXCEEDS_SOLD: 'The requested return quantity exceeds the quantity sold.',
  RETURN_WINDOW_CLOSED: 'This sale is outside the permitted return period.',
  RESTOCK_NOT_ALLOWED: 'The returned item does not meet the restocking policy.',
  RESTOCK_UNIT_INVALID: 'The returned quantity does not match an allowed package.',
  RESTOCK_UNIT_REQUIRED: 'Select the original sealed package type to restock.',
  SESSION_EXPIRED: 'Your session has expired. Sign in again.',
  SETUP_ALREADY_COMPLETED: 'Initial setup has already been completed.',
  SETUP_CODE_INVALID: 'The one-time setup code is invalid or expired.',
  SETUP_UNAVAILABLE: 'First-run setup is not enabled on this installation.',
  STOCK_PERMISSION_REQUIRED: 'Stock Inventory permission is required for restocking.',
  UNAUTHENTICATED: 'Your session has expired. Sign in again.',
  VALIDATION_FAILED: 'Correct the fields marked in the form.',
};

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = ERROR_MESSAGES[code] ?? 'The request could not be completed.',
    readonly fieldErrors: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;

function notifyApiUnavailable(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('pharma-care:api-unavailable'));
  }
}

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
  const fieldErrors: Record<string, string> = {};
  if (isRecord(body.fields)) {
    for (const [field, value] of Object.entries(body.fields)) {
      if (typeof value === 'string') fieldErrors[field] = value;
    }
  }
  const message = code === 'VALIDATION_FAILED' && Object.keys(fieldErrors).length > 0
    ? `Check: ${Object.keys(fieldErrors).join(', ')}.`
    : safeMessage;
  return new ApiError(code, response.status, message, fieldErrors);
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
    const response = await fetch(path, {
      ...init,
      headers,
      credentials: 'include',
    });
    if ([502, 503, 504].includes(response.status)) notifyApiUnavailable();
    return response;
  } catch {
    notifyApiUnavailable();
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

  const requestInit: RequestInit = { ...init };
  const method = (requestInit.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)
    && !['/api/auth/login', '/api/auth/refresh', '/api/auth/logout'].includes(path)
    && !new Headers(requestInit.headers).has('Idempotency-Key')) {
    const headers = new Headers(requestInit.headers);
    headers.set('Idempotency-Key', globalThis.crypto.randomUUID());
    requestInit.headers = headers;
  }

  let response = await send(path, requestInit, accessToken);
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
    response = await send(path, requestInit, token);
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
