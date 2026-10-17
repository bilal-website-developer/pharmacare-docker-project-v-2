import { apiRequest } from '../api';

export interface DashboardSummary {
  today: string;
  saleCount: number;
  sellableStockBaseUnits: string;
  lowStockMedicines: number;
  nearExpiryBatches: number;
  expiredBatches: number;
  todaySalesPaisa?: string;
  grossSalesPaisa?: string;
  returnsPaisa?: string;
  expensesPaisa?: string;
  monthNetSalesPaisa?: string;
  cashSalesPaisa?: string;
  creditSalesPaisa?: string;
  receivablesPaisa?: string;
  cashPurchasesPaisa?: string;
  expectedDrawerPaisa?: string;
}

export interface SalesReportSummary {
  dateFrom: string | null;
  dateTo: string | null;
  grossSalesPaisa: string;
  returnsPaisa: string;
  netSalesPaisa: string;
  saleCount: number;
  returnCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validPaisa(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function validSignedPaisa(value: unknown): value is string {
  return typeof value === 'string' && /^(0|-?[1-9]\d*)$/.test(value);
}

function readPaisa(value: unknown): string {
  if (!validPaisa(value)) throw invalidResponse();
  return value;
}

function readSignedPaisa(value: unknown): string {
  if (!validSignedPaisa(value)) throw invalidResponse();
  return value;
}

function invalidResponse(): Error {
  return new Error('The reports service returned an invalid response.');
}

export function parseDashboardSummary(value: unknown): DashboardSummary {
  const activityKeys = [
    'today', 'saleCount', 'sellableStockBaseUnits', 'lowStockMedicines',
    'nearExpiryBatches', 'expiredBatches',
  ] as const;
  const financialKeys = [
    ...activityKeys, 'todaySalesPaisa', 'grossSalesPaisa', 'returnsPaisa',
    'expensesPaisa', 'monthNetSalesPaisa', 'cashSalesPaisa',
    'creditSalesPaisa', 'receivablesPaisa', 'cashPurchasesPaisa',
    'expectedDrawerPaisa',
  ] as const;
  if (!isRecord(value)
    || !(exactKeys(value, activityKeys) || exactKeys(value, financialKeys))
    || !validDate(value.today)
    || !validPaisa(value.sellableStockBaseUnits)
    || !validCount(value.saleCount)
    || !validCount(value.lowStockMedicines)
    || !validCount(value.nearExpiryBatches)
    || !validCount(value.expiredBatches)) {
    throw invalidResponse();
  }
  if (exactKeys(value, financialKeys)) {
    for (const key of [
      'grossSalesPaisa', 'returnsPaisa', 'expensesPaisa', 'cashSalesPaisa',
      'creditSalesPaisa', 'receivablesPaisa', 'cashPurchasesPaisa',
    ]) {
      if (!validPaisa(value[key])) throw invalidResponse();
    }
    if (!validSignedPaisa(value.todaySalesPaisa)
      || !validSignedPaisa(value.monthNetSalesPaisa)
      || !validSignedPaisa(value.expectedDrawerPaisa)) {
      throw invalidResponse();
    }
  }
  const summary: DashboardSummary = {
    today: value.today,
    saleCount: value.saleCount,
    sellableStockBaseUnits: value.sellableStockBaseUnits,
    lowStockMedicines: value.lowStockMedicines,
    nearExpiryBatches: value.nearExpiryBatches,
    expiredBatches: value.expiredBatches,
  };
  if (exactKeys(value, financialKeys)) {
    summary.todaySalesPaisa = readSignedPaisa(value.todaySalesPaisa);
    summary.grossSalesPaisa = readPaisa(value.grossSalesPaisa);
    summary.returnsPaisa = readPaisa(value.returnsPaisa);
    summary.expensesPaisa = readPaisa(value.expensesPaisa);
    summary.monthNetSalesPaisa = readSignedPaisa(value.monthNetSalesPaisa);
    summary.cashSalesPaisa = readPaisa(value.cashSalesPaisa);
    summary.creditSalesPaisa = readPaisa(value.creditSalesPaisa);
    summary.receivablesPaisa = readPaisa(value.receivablesPaisa);
    summary.cashPurchasesPaisa = readPaisa(value.cashPurchasesPaisa);
    summary.expectedDrawerPaisa = readSignedPaisa(value.expectedDrawerPaisa);
  }
  return summary;
}

export async function loadDashboardSummary(): Promise<DashboardSummary> {
  return parseDashboardSummary(await apiRequest<unknown>('/api/dashboard/summary'));
}

export function parseSalesReportSummary(value: unknown): SalesReportSummary {
  const keys = [
    'dateFrom', 'dateTo', 'grossSalesPaisa', 'returnsPaisa',
    'netSalesPaisa', 'saleCount', 'returnCount',
  ] as const;
  if (!isRecord(value)
    || !exactKeys(value, keys)
    || !(value.dateFrom === null || validDate(value.dateFrom))
    || !(value.dateTo === null || validDate(value.dateTo))
    || !validPaisa(value.grossSalesPaisa)
    || !validPaisa(value.returnsPaisa)
    || !validSignedPaisa(value.netSalesPaisa)
    || !validCount(value.saleCount)
    || !validCount(value.returnCount)) {
    throw invalidResponse();
  }
  return {
    dateFrom: value.dateFrom,
    dateTo: value.dateTo,
    grossSalesPaisa: value.grossSalesPaisa,
    returnsPaisa: value.returnsPaisa,
    netSalesPaisa: value.netSalesPaisa,
    saleCount: value.saleCount,
    returnCount: value.returnCount,
  };
}

export async function loadSalesReportSummary(): Promise<SalesReportSummary> {
  return parseSalesReportSummary(await apiRequest<unknown>('/api/reports/sales'));
}

export function formatPaisa(value: string | null | undefined): string {
  if (value === undefined || value === null) return 'Unavailable';
  const amount = BigInt(value);
  const absoluteAmount = amount < 0n ? -amount : amount;
  const rupees = absoluteAmount / 100n;
  const paisa = String(absoluteAmount % 100n).padStart(2, '0');
  return `${amount < 0n ? '-' : ''}Rs. ${rupees.toLocaleString('en-PK')}.${paisa}`;
}
