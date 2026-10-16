import {
  callSupabaseRpc,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  isString,
} from './sales';
import { apiRequest, getBackend } from '../api';
import type { ReturnDisposition } from './returnLogic';

export interface SaleReturnAllocation {
  allocationId: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  quantityBaseUnits: number;
  alreadyReturnedBaseUnits: number;
}

export interface SaleForReturnItem {
  saleItemId: string;
  medicineId: string;
  productName: string;
  genericName: string;
  unitName: string;
  conversionFactor: number;
  quantityInUnit: number;
  quantityBaseUnits: number;
  lineTotalPaisa: number;
  drugClass: string;
  storageCondition: string;
  allocations: SaleReturnAllocation[];
}

export interface SaleForReturn {
  id: string;
  invoiceNumber: string;
  saleDate: string;
  customerId: string | null;
  customerName: string;
  totalPaisa: number;
  items: SaleForReturnItem[];
}

export interface PendingReturnItem {
  id: string;
  saleItemId: string;
  medicineId: string;
  productName: string;
  unitName: string;
  conversionFactor: number;
  quantityBaseUnits: number;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  drugClass: string;
  storageCondition: string;
  medicineUnits: Array<{ id: string; name: string; conversionFactor: number }>;
}

export interface PendingSaleReturn {
  id: string;
  saleId: string;
  status?: 'PENDING' | 'APPROVED';
  invoiceNumber: string;
  saleDate: string;
  customerName: string;
  reason: string;
  requestedBy: string;
  requestedAt: string;
  items: PendingReturnItem[];
}

export interface ReturnPolicySettings {
  returnWindowDays: number;
  minimumRestockShelfLifeDays: number;
  today?: string;
}

export interface SaleReturnRequestItem {
  saleItemId: string;
  allocationId: string;
  quantityBaseUnits: number;
}

export interface SaleReturnDecision {
  id: string;
  disposition: ReturnDisposition;
  sealedIntact: boolean;
  restockUnitId: string | null;
  reason: string;
}

export interface CompletedSaleReturn {
  id: string;
  invoiceNumber: string;
  status: 'COMPLETED';
  refundMethod: 'CASH' | 'CARD' | 'CREDIT' | 'SPLIT';
  refundTotalPaisa: number;
  customerBalancePaisa: number | null;
  customerStoreCreditPaisa: number | null;
  items: Array<{
    productName: string;
    unitName: string;
    quantityBaseUnits: number;
    disposition: ReturnDisposition;
    refundPaisa: number;
  }>;
}

function isDate(value: unknown): value is string {
  return isString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isAllocation(value: unknown): value is SaleReturnAllocation {
  return isRecord(value)
    && isString(value.allocationId)
    && isString(value.batchId)
    && isString(value.batchNumber)
    && isDate(value.expiryDate)
    && isPositiveInteger(value.quantityBaseUnits)
    && isNonNegativeInteger(value.alreadyReturnedBaseUnits);
}

function isSaleItem(value: unknown): value is SaleForReturnItem {
  return isRecord(value)
    && isString(value.saleItemId)
    && isString(value.medicineId)
    && isString(value.productName)
    && isString(value.genericName)
    && isString(value.unitName)
    && isPositiveInteger(value.conversionFactor)
    && isPositiveInteger(value.quantityInUnit)
    && isPositiveInteger(value.quantityBaseUnits)
    && isNonNegativeInteger(value.lineTotalPaisa)
    && isString(value.drugClass)
    && isString(value.storageCondition)
    && Array.isArray(value.allocations)
    && value.allocations.every(isAllocation);
}

function isSaleForReturn(value: unknown): value is SaleForReturn {
  return isRecord(value)
    && isString(value.id)
    && isString(value.invoiceNumber)
    && isDate(value.saleDate)
    && (value.customerId === null || isString(value.customerId))
    && isString(value.customerName)
    && isNonNegativeInteger(value.totalPaisa)
    && Array.isArray(value.items)
    && value.items.every(isSaleItem);
}

function isPendingReturnItem(value: unknown): value is PendingReturnItem {
  return isRecord(value)
    && isString(value.id)
    && isString(value.saleItemId)
    && isString(value.medicineId)
    && isString(value.productName)
    && isString(value.unitName)
    && isPositiveInteger(value.conversionFactor)
    && isPositiveInteger(value.quantityBaseUnits)
    && isString(value.batchId)
    && isString(value.batchNumber)
    && isDate(value.expiryDate)
    && isString(value.drugClass)
    && isString(value.storageCondition)
    && Array.isArray(value.medicineUnits)
    && value.medicineUnits.every((unit: unknown) => isRecord(unit)
      && isString(unit.id)
      && isString(unit.name)
      && isPositiveInteger(unit.conversionFactor));
}

function isPendingReturn(value: unknown): value is PendingSaleReturn {
  return isRecord(value)
    && isString(value.id)
    && isString(value.saleId)
    && isString(value.invoiceNumber)
    && isDate(value.saleDate)
    && isString(value.customerName)
    && isString(value.reason)
    && isString(value.requestedBy)
    && isString(value.requestedAt)
    && Array.isArray(value.items)
    && value.items.every(isPendingReturnItem);
}

function isPolicy(value: unknown): value is ReturnPolicySettings {
  return isRecord(value)
    && isNonNegativeInteger(value.returnWindowDays)
    && isNonNegativeInteger(value.minimumRestockShelfLifeDays);
}

function isReturnRequestResponse(value: unknown): value is { id: string; status: 'PENDING'; invoiceNumber: string } {
  return isRecord(value)
    && isString(value.id)
    && value.status === 'PENDING'
    && isString(value.invoiceNumber);
}

function isCompletedReturn(value: unknown): value is CompletedSaleReturn {
  return isRecord(value)
    && isString(value.id)
    && isString(value.invoiceNumber)
    && value.status === 'COMPLETED'
    && (value.refundMethod === 'CASH' || value.refundMethod === 'CARD'
      || value.refundMethod === 'CREDIT' || value.refundMethod === 'SPLIT')
    && isNonNegativeInteger(value.refundTotalPaisa)
    && (value.customerBalancePaisa === null || isNonNegativeInteger(value.customerBalancePaisa))
    && (value.customerStoreCreditPaisa === null || isNonNegativeInteger(value.customerStoreCreditPaisa))
    && Array.isArray(value.items)
    && value.items.every((item: unknown) => isRecord(item)
      && isString(item.productName)
      && isString(item.unitName)
      && isPositiveInteger(item.quantityBaseUnits)
      && (item.disposition === 'RESTOCK' || item.disposition === 'QUARANTINE' || item.disposition === 'WRITE_OFF')
      && isNonNegativeInteger(item.refundPaisa));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

const RETURN_DTO_KEYS = [
  'id', 'returnNumber', 'saleId', 'invoiceNumber', 'status', 'reason', 'requestedAt',
  'requestedByName', 'decidedAt', 'decidedByName', 'note', 'refundPaisa', 'refundMethod', 'items',
] as const;
const RETURN_ITEM_DTO_KEYS = [
  'id', 'saleItemId', 'allocationId', 'medicineName', 'unitName', 'batchNumber', 'expiryDate',
  'drugClass', 'storageCondition', 'quantityBaseUnits', 'refundPaisa', 'disposition', 'reason',
] as const;

function isReturnDto(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && exactKeys(value, RETURN_DTO_KEYS)
    && Array.isArray(value.items)
    && value.items.every((item) => isRecord(item) && exactKeys(item, RETURN_ITEM_DTO_KEYS));
}

function apiInteger(value: unknown, positive = false): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (!positive || parsed > 0) ? parsed : null;
}

function parseApiPolicy(value: unknown): ReturnPolicySettings {
  if (!isRecord(value)
    || !(exactKeys(value, ['returnWindowDays', 'minimumRestockShelfLifeDays'])
      || exactKeys(value, ['returnWindowDays', 'minimumRestockShelfLifeDays', 'today']))
    || !isNonNegativeInteger(value.returnWindowDays)
    || !isNonNegativeInteger(value.minimumRestockShelfLifeDays)
    || ('today' in value && !isDate(value.today))) {
    throw new Error('The returns service returned invalid settings.');
  }
  return {
    returnWindowDays: value.returnWindowDays,
    minimumRestockShelfLifeDays: value.minimumRestockShelfLifeDays,
    ...('today' in value && typeof value.today === 'string' ? { today: value.today } : {}),
  };
}

function parseApiSale(value: unknown): SaleForReturn {
  if (!isRecord(value) || !exactKeys(value, [
    'id', 'invoiceNumber', 'saleDate', 'customerId', 'customerName', 'totalPaisa', 'items',
  ]) || !Array.isArray(value.items)) {
    throw new Error('The returns service returned invalid sale details.');
  }
  const totalPaisa = apiInteger(value.totalPaisa);
  if (totalPaisa === null) throw new Error('The returns service returned invalid sale details.');
  const items = value.items.map((rawItem) => {
    if (!isRecord(rawItem) || !exactKeys(rawItem, [
      'saleItemId', 'medicineId', 'productName', 'genericName', 'unitName', 'conversionFactor',
      'quantityInUnit', 'quantityBaseUnits', 'lineTotalPaisa', 'drugClass', 'storageCondition', 'allocations',
    ]) || !Array.isArray(rawItem.allocations)) {
      throw new Error('The returns service returned invalid sale details.');
    }
    const quantityBaseUnits = apiInteger(rawItem.quantityBaseUnits, true);
    const lineTotalPaisa = apiInteger(rawItem.lineTotalPaisa);
    const allocations = rawItem.allocations.map((rawAllocation) => {
      if (!isRecord(rawAllocation) || !exactKeys(rawAllocation, [
        'allocationId', 'batchId', 'batchNumber', 'expiryDate', 'quantityBaseUnits', 'alreadyReturnedBaseUnits',
      ])) throw new Error('The returns service returned invalid sale details.');
      const allocated = apiInteger(rawAllocation.quantityBaseUnits, true);
      const alreadyReturned = apiInteger(rawAllocation.alreadyReturnedBaseUnits);
      if (allocated === null || alreadyReturned === null) {
        throw new Error('The returns service returned invalid sale details.');
      }
      return { ...rawAllocation, quantityBaseUnits: allocated, alreadyReturnedBaseUnits: alreadyReturned };
    });
    if (quantityBaseUnits === null || lineTotalPaisa === null) {
      throw new Error('The returns service returned invalid sale details.');
    }
    return { ...rawItem, quantityBaseUnits, lineTotalPaisa, allocations };
  });
  const result = { ...value, totalPaisa, items };
  if (!isSaleForReturn(result)) throw new Error('The returns service returned invalid sale details.');
  return result;
}

function parseApiPendingReturn(value: unknown): PendingSaleReturn {
  if (!isRecord(value) || !exactKeys(value, [
    'id', 'saleId', 'status', 'invoiceNumber', 'saleDate', 'customerName', 'reason',
    'requestedBy', 'requestedAt', 'items',
  ]) || (value.status !== 'PENDING' && value.status !== 'APPROVED') || !Array.isArray(value.items)) {
    throw new Error('The returns service returned invalid pending requests.');
  }
  const items = value.items.map((rawItem) => {
    if (!isRecord(rawItem) || !exactKeys(rawItem, [
      'id', 'saleItemId', 'medicineId', 'productName', 'unitName', 'conversionFactor',
      'quantityBaseUnits', 'batchId', 'batchNumber', 'expiryDate', 'drugClass', 'storageCondition',
      'medicineUnits',
    ]) || !Array.isArray(rawItem.medicineUnits)) {
      throw new Error('The returns service returned invalid pending requests.');
    }
    const quantityBaseUnits = apiInteger(rawItem.quantityBaseUnits, true);
    const medicineUnits = rawItem.medicineUnits.map((rawUnit) => {
      if (!isRecord(rawUnit) || !exactKeys(rawUnit, ['id', 'name', 'conversionFactor'])) {
        throw new Error('The returns service returned invalid pending requests.');
      }
      return rawUnit;
    });
    if (quantityBaseUnits === null) throw new Error('The returns service returned invalid pending requests.');
    const parsed = { ...rawItem, quantityBaseUnits, medicineUnits };
    if (!isPendingReturnItem(parsed)) throw new Error('The returns service returned invalid pending requests.');
    return parsed;
  });
  const result = { ...value, items };
  if (!isPendingReturn(result)) throw new Error('The returns service returned invalid pending requests.');
  return result;
}

function parseApiRequestResponse(value: unknown): { id: string; status: 'PENDING'; invoiceNumber: string } {
  if (!isReturnDto(value) || !isString(value.id) || value.status !== 'PENDING'
    || !isString(value.invoiceNumber)) {
    throw new Error('The returns service returned an invalid request response.');
  }
  return { id: value.id, status: 'PENDING', invoiceNumber: value.invoiceNumber };
}

function parseApiCompletedReturn(value: unknown): CompletedSaleReturn {
  if (!isReturnDto(value) || !isString(value.id) || !isString(value.invoiceNumber)
    || value.status !== 'COMPLETED'
    || !['CASH', 'CARD', 'CREDIT', 'SPLIT'].includes(String(value.refundMethod))
    || !Array.isArray(value.items)) {
    throw new Error('The returns service returned an invalid completed return.');
  }
  const refundTotalPaisa = apiInteger(value.refundPaisa);
  if (refundTotalPaisa === null) throw new Error('The returns service returned an invalid completed return.');
  const items = value.items.map((rawItem) => {
    if (!isRecord(rawItem) || !exactKeys(rawItem, RETURN_ITEM_DTO_KEYS)
      || !isString(rawItem.medicineName) || !isString(rawItem.unitName)
      || !['RESTOCK', 'QUARANTINE', 'WRITE_OFF'].includes(String(rawItem.disposition))) {
      throw new Error('The returns service returned an invalid completed return.');
    }
    const quantityBaseUnits = apiInteger(rawItem.quantityBaseUnits, true);
    const refundPaisa = apiInteger(rawItem.refundPaisa);
    if (quantityBaseUnits === null || refundPaisa === null) {
      throw new Error('The returns service returned an invalid completed return.');
    }
    return {
      productName: rawItem.medicineName,
      unitName: rawItem.unitName,
      quantityBaseUnits,
      disposition: rawItem.disposition,
      refundPaisa,
    };
  });
  const result = {
    id: value.id,
    invoiceNumber: value.invoiceNumber,
    status: 'COMPLETED' as const,
    refundMethod: value.refundMethod as CompletedSaleReturn['refundMethod'],
    refundTotalPaisa,
    customerBalancePaisa: null,
    customerStoreCreditPaisa: null,
    items,
  };
  if (!isCompletedReturn(result)) throw new Error('The returns service returned an invalid completed return.');
  return result;
}

function parseApiDecisionResponse(value: unknown, status: 'APPROVED' | 'REJECTED'): void {
  if (!isReturnDto(value) || value.status !== status || !isString(value.id)) {
    throw new Error('The returns service returned an invalid decision response.');
  }
}

export async function getReturnPolicySettings(): Promise<ReturnPolicySettings> {
  if (getBackend() === 'api') return parseApiPolicy(await apiRequest<unknown>('/api/returns/policy'));
  return callSupabaseRpc('get_return_policy_settings', undefined, 'Could not load return settings.', isPolicy);
}

export async function updateReturnPolicySettings(settings: ReturnPolicySettings): Promise<ReturnPolicySettings> {
  if (getBackend() === 'api') {
    return parseApiPolicy(await apiRequest<unknown>('/api/returns/policy', {
      method: 'PATCH',
      body: JSON.stringify(settings),
    }));
  }
  return callSupabaseRpc('update_return_policy_settings', {
    p_return_window_days: settings.returnWindowDays,
    p_minimum_restock_shelf_life_days: settings.minimumRestockShelfLifeDays,
  }, 'Could not save return settings.', isPolicy);
}

export async function loadSaleForReturn(invoiceNumber: string): Promise<SaleForReturn> {
  if (getBackend() === 'api') {
    return parseApiSale(await apiRequest<unknown>(
      `/api/returns/sales/${encodeURIComponent(invoiceNumber)}`,
    ));
  }
  return callSupabaseRpc('sale_for_return', { p_invoice_number: invoiceNumber }, 'Could not find the sale.', isSaleForReturn);
}

export async function requestSaleReturn(
  saleId: string,
  reason: string,
  items: readonly SaleReturnRequestItem[],
): Promise<{ id: string; status: 'PENDING'; invoiceNumber: string }> {
  if (getBackend() === 'api') {
    return parseApiRequestResponse(await apiRequest<unknown>(`/api/sales/${encodeURIComponent(saleId)}/returns`, {
      method: 'POST',
      body: JSON.stringify({ reason, items }),
    }));
  }
  return callSupabaseRpc('request_sale_return', {
    p_sale_id: saleId,
    p_reason: reason,
    p_items: items.map((item) => ({
      sale_item_id: item.saleItemId,
      allocation_id: item.allocationId,
      quantity_base_units: item.quantityBaseUnits,
    })),
  }, 'Could not submit the return request.', isReturnRequestResponse);
}

export async function loadPendingSaleReturns(): Promise<PendingSaleReturn[]> {
  if (getBackend() === 'api') {
    const response: unknown = await apiRequest('/api/returns/pending');
    if (!isRecord(response) || !exactKeys(response, ['items']) || !Array.isArray(response.items)) {
      throw new Error('The returns service returned invalid pending requests.');
    }
    return response.items.map(parseApiPendingReturn);
  }
  return callSupabaseRpc('pending_sale_returns', undefined, 'Could not load pending returns.', (value): value is PendingSaleReturn[] =>
    Array.isArray(value) && value.every(isPendingReturn));
}

export async function processSaleReturn(
  returnId: string,
  decisions: readonly SaleReturnDecision[],
): Promise<CompletedSaleReturn> {
  if (getBackend() === 'api') {
    return parseApiCompletedReturn(await apiRequest<unknown>(
      `/api/returns/${encodeURIComponent(returnId)}/process`,
      { method: 'POST', body: JSON.stringify({ items: decisions }) },
    ));
  }
  return callSupabaseRpc('process_sale_return', {
    p_return_id: returnId,
    p_decisions: decisions.map((decision) => ({
      id: decision.id,
      disposition: decision.disposition,
      sealedIntact: decision.sealedIntact,
      restockUnitId: decision.restockUnitId,
      reason: decision.reason,
    })),
  }, 'Could not process the return.', isCompletedReturn);
}

export async function rejectSaleReturn(returnId: string, reason: string): Promise<void> {
  if (getBackend() === 'api') {
    const response: unknown = await apiRequest(`/api/returns/${encodeURIComponent(returnId)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    parseApiDecisionResponse(response, 'REJECTED');
    return;
  }
  await callSupabaseRpc('reject_sale_return', {
    p_return_id: returnId,
    p_reason: reason,
  }, 'Could not reject the return request.', (value): value is { id: string; status: 'REJECTED' } =>
    isRecord(value) && isString(value.id) && value.status === 'REJECTED');
}

export async function approveSaleReturn(returnId: string): Promise<void> {
  if (getBackend() !== 'api') throw new Error('Return approval is only available through the API backend.');
  const response: unknown = await apiRequest(`/api/returns/${encodeURIComponent(returnId)}/approve`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  parseApiDecisionResponse(response, 'APPROVED');
}
