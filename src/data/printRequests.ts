import { apiRequest } from '../api';
import { parsePrintRequestRecord, type PrintRequestRecord } from '../utils/printRequestTypes';
import type { PrintSnapshot } from '../utils/printSnapshot';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): PrintRequestRecord {
  if (!isRecord(value)) throw new Error('The print-request service returned an invalid response.');
  const hasRequester = 'requester_name' in value;
  const expectedKeys = [
    'id', 'type', 'receipt_ref', 'requested_by',
    ...(hasRequester ? ['requester_name'] : []),
    'requested_at', 'status', 'decided_by', 'decided_at', 'note', 'printed_at', 'payload',
  ];
  if (Object.keys(value).length !== expectedKeys.length
    || expectedKeys.some((key) => !(key in value))) {
    throw new Error('The print-request service returned an invalid response.');
  }
  return parsePrintRequestRecord(value);
}

async function requestList(path: string): Promise<PrintRequestRecord[]> {
  const response = await apiRequest<unknown>(path);
  if (!isRecord(response) || Object.keys(response).length !== 1
    || !Array.isArray(response.items)) {
    throw new Error('The print-request service returned an invalid response.');
  }
  return response.items.map(parseRequest);
}

export function loadMyPrintRequests(): Promise<PrintRequestRecord[]> {
  return requestList('/api/print-requests/mine');
}

export function loadAdminPrintRequests(): Promise<PrintRequestRecord[]> {
  return requestList('/api/admin/print-requests');
}

export async function loadPendingPrintCount(): Promise<number> {
  const response = await apiRequest<unknown>('/api/admin/print-requests/pending-count');
  if (!isRecord(response) || Object.keys(response).length !== 1
    || !Number.isSafeInteger(response.count) || Number(response.count) < 0) {
    throw new Error('The print-request service returned an invalid count.');
  }
  return Number(response.count);
}

export async function decidePrintRequest(
  id: string,
  decision: 'approved' | 'rejected',
  note: string | null,
): Promise<PrintRequestRecord> {
  const response = await apiRequest<unknown>(`/api/admin/print-requests/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, note }),
  });
  return parseRequest(response);
}

export async function modifyPrintRequest(
  id: string,
  payload: PrintSnapshot,
): Promise<PrintRequestRecord> {
  const response = await apiRequest<unknown>(`/api/admin/print-requests/${encodeURIComponent(id)}/snapshot`, {
    method: 'PATCH',
    body: JSON.stringify({ payload, reason: 'Audited receipt snapshot edit' }),
  });
  return parseRequest(response);
}

export async function submitPrintRequest(
  type: 'sale' | 'payment',
  receiptRef: string,
  payload: PrintSnapshot,
): Promise<void> {
  const response = await apiRequest<unknown>('/api/print-requests', {
    method: 'POST',
    body: JSON.stringify({ type, receiptRef, payload }),
  });
  if (!isRecord(response) || Object.keys(response).length !== 6
    || typeof response.id !== 'string' || response.type !== type
    || response.receipt_ref !== receiptRef || typeof response.requested_by !== 'string'
    || typeof response.requested_at !== 'string' || response.status !== 'pending') {
    throw new Error('The print-request service returned an invalid response.');
  }
}

export async function markPrintRequestPrinted(id: string): Promise<void> {
  const response = await apiRequest<unknown>(
    `/api/print-requests/${encodeURIComponent(id)}/printed`,
    { method: 'POST' },
  );
  if (!isRecord(response) || Object.keys(response).length !== 2
    || response.status !== 'approved' || typeof response.printedAt !== 'string') {
    throw new Error('Print tracking returned an invalid response.');
  }
}
