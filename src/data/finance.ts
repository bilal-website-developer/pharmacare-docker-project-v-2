import { apiRequest } from '../api';
import type { CashTransaction } from '../types/pharmacy';

export interface CashBookData {
  transactions: CashTransaction[];
  inflowPaisa: number;
  outflowPaisa: number;
  expectedDrawerPaisa: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function safePaisa(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('The cash book service returned an invalid response.');
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error('The cash book service returned an invalid response.');
  return amount;
}

export function parsePaisaInput(value: string): number | null {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const amount = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

function mapEntry(value: unknown): CashTransaction {
  const keys = [
    'id', 'type', 'direction', 'amountPaisa', 'description', 'paymentMethod',
    'createdAt', 'referenceType', 'referenceId',
  ] as const;
  if (!isRecord(value) || !exactKeys(value, keys)
    || typeof value.id !== 'string'
    || typeof value.type !== 'string'
    || (value.direction !== 'IN' && value.direction !== 'OUT')
    || typeof value.description !== 'string'
    || typeof value.paymentMethod !== 'string'
    || typeof value.createdAt !== 'string'
    || Number.isNaN(Date.parse(value.createdAt))
    || typeof value.referenceType !== 'string'
    || typeof value.referenceId !== 'string') {
    throw new Error('The cash book service returned an invalid response.');
  }
  const entryType = value.type;
  const type: CashTransaction['type'] = entryType.includes('RETURN')
    ? 'RETURN'
    : entryType.includes('VOID')
      ? 'SALE_VOID'
      : entryType.includes('ADJUSTMENT')
        ? 'ADJUSTMENT'
        : entryType.includes('SALE')
          ? 'SALE'
          : entryType.includes('PAYMENT')
            ? 'CREDIT_RECOVERY'
            : 'EXPENSE';
  return {
    id: value.id,
    time: new Date(value.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    type,
    description: value.description,
    amountPaisa: safePaisa(value.amountPaisa),
    isOutflow: value.direction === 'OUT',
    handledBy: '—',
  };
}

export async function loadCashBook(): Promise<CashBookData> {
  const transactions: CashTransaction[] = [];
  let page = 1;
  let total = Number.MAX_SAFE_INTEGER;
  let totals: CashBookData | null = null;
  while (transactions.length < total) {
    const query = new URLSearchParams({ page: String(page), pageSize: '200' });
    const response = await apiRequest<unknown>(`/api/cash-book?${query.toString()}`);
    const keys = ['items', 'totals', 'total', 'page', 'pageSize'] as const;
    if (!isRecord(response) || !exactKeys(response, keys)
      || !Array.isArray(response.items)
      || !Number.isSafeInteger(response.total) || Number(response.total) < 0
      || response.page !== page || response.pageSize !== 200
      || !isRecord(response.totals)
      || !exactKeys(response.totals, ['inflowPaisa', 'outflowPaisa', 'expectedDrawerPaisa'])) {
      throw new Error('The cash book service returned an invalid response.');
    }
    total = Number(response.total);
    transactions.push(...response.items.map(mapEntry));
    totals = {
      transactions: [],
      inflowPaisa: safePaisa(response.totals.inflowPaisa),
      outflowPaisa: safePaisa(response.totals.outflowPaisa),
      expectedDrawerPaisa: safeSignedPaisa(response.totals.expectedDrawerPaisa),
    };
    if (response.items.length === 0 || transactions.length >= total) break;
    page += 1;
  }
  if (!totals) {
    return { transactions, inflowPaisa: 0, outflowPaisa: 0, expectedDrawerPaisa: 0 };
  }
  return { ...totals, transactions };
}

function safeSignedPaisa(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|-?[1-9]\d*)$/.test(value)) {
    throw new Error('The cash book service returned an invalid response.');
  }
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error('The cash book service returned an invalid response.');
  return amount;
}

export async function createCashExpense(description: string, amountPaisa: number): Promise<void> {
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa <= 0) {
    throw new Error('Enter a valid positive expense amount.');
  }
  const response = await apiRequest<unknown>('/api/expenses', {
    method: 'POST',
    body: JSON.stringify({
      category: 'Operating',
      description,
      amountPaisa: String(amountPaisa),
      occurredAt: new Date().toISOString(),
    }),
  });
  if (!isRecord(response)
    || !exactKeys(response, ['id', 'category', 'description', 'amountPaisa', 'occurredAt', 'status'])
    || typeof response.id !== 'string'
    || response.category !== 'Operating'
    || response.description !== description
    || safePaisa(response.amountPaisa) !== amountPaisa
    || typeof response.occurredAt !== 'string'
    || response.status !== 'ACTIVE') {
    throw new Error('The expense service returned an invalid response.');
  }
}
