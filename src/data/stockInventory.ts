import { apiRequest } from '../api';

export type StockInventoryTab = 'all' | 'near-expiry' | 'expired' | 'low-stock';
export type StockInventorySort = 'medicine_asc' | 'medicine_desc' | 'batch_asc' | 'batch_desc'
  | 'expiry_asc' | 'expiry_desc' | 'quantity_asc' | 'quantity_desc' | 'cost_asc' | 'cost_desc'
  | 'value_asc' | 'value_desc';
export type StockExpiryBucketKey = 'expired' | '0-30' | '31-60' | '61-90' | '90+';

export interface StockInventoryBatch {
  id: string;
  medicine_id: string;
  medicine_name: string;
  generic_name: string;
  code: string;
  batch_number: string;
  expiry_date: string;
  received_date: string;
  quantity_remaining: number;
  status: string;
  min_stock_alert: number;
  cost_paisa_per_base_unit: string | null;
  mrp_paisa_per_base_unit: string;
  stock_value_cost_paisa: string | null;
  is_sellable: boolean;
}

export interface StockInventoryList {
  rows: StockInventoryBatch[];
  total_count: number;
  page: number;
  page_size: number;
  can_view_cost: boolean;
}

export interface StockInventoryStats {
  stock_value_cost_paisa: string | null;
  stock_value_mrp_paisa: string;
  expiring_30: number;
  expired_batches: number;
  expired_value_at_risk_paisa: string | null;
}

export interface StockInventoryExpiryBucket {
  key: StockExpiryBucketKey;
  label: string;
  count: number;
  quantity_remaining: number;
}

export interface StockInventoryMovement {
  id: string;
  batch_id: string;
  batch_number: string;
  medicine_id: string;
  medicine_name: string;
  generic_name: string;
  movement_type: string;
  quantity_delta: number;
  reason: string;
  created_at: string;
  actor_name: string;
}

export interface StockInventoryMovements {
  rows: StockInventoryMovement[];
  total_count: number;
  page: number;
  page_size: number;
}

export interface StockInventoryBatchQuery {
  tab: StockInventoryTab;
  search: string;
  sort: StockInventorySort;
  page: number;
  pageSize: number;
  medicineId: string | null;
  expiryBucket: StockExpiryBucketKey | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

function safeInteger(value: unknown, minimum = 0): number {
  const number = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || Number(number) < minimum) {
    throw new Error('The stock service returned an invalid response.');
  }
  return Number(number);
}

function isPaisa(value: unknown): value is string | number {
  return (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function paisaString(value: string | number): string {
  return typeof value === 'string' ? value : String(value);
}

function requiredText(value: unknown): value is string {
  return typeof value === 'string';
}

function queryUrl(path: string, values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function parseBatch(value: unknown): StockInventoryBatch {
  const required = [
    'id', 'medicineId', 'medicineName', 'genericName', 'medicineCode', 'barcode',
    'medicineIsActive', 'minStockAlert', 'supplierId', 'supplierName', 'purchaseId',
    'batchNumber', 'expiryDate', 'receivedDate', 'quantityReceivedBaseUnits',
    'quantityReturnedBaseUnits', 'quantityRemainingBaseUnits', 'status', 'isSellable',
    'sellableStockBaseUnits', 'mrpPaisaPerBaseUnit',
  ];
  const optional = ['unitCostPaisaPerBaseUnit', 'stockValueCostPaisa'];
  if (!isRecord(value) || !hasOnlyKeys(value, required, optional)
    || !isId(value.id) || !isId(value.medicineId) || !requiredText(value.medicineName)
    || !requiredText(value.genericName) || !requiredText(value.medicineCode)
    || !(value.barcode === null || requiredText(value.barcode))
    || typeof value.medicineIsActive !== 'boolean'
    || !Number.isSafeInteger(value.minStockAlert) || Number(value.minStockAlert) < 0
    || !isId(value.supplierId) || !requiredText(value.supplierName) || !isId(value.purchaseId)
    || !requiredText(value.batchNumber) || !requiredText(value.expiryDate) || !requiredText(value.receivedDate)
    || typeof value.status !== 'string' || typeof value.isSellable !== 'boolean'
    || !isPaisa(value.mrpPaisaPerBaseUnit)
    || (value.unitCostPaisaPerBaseUnit !== undefined && !isPaisa(value.unitCostPaisaPerBaseUnit))
    || (value.stockValueCostPaisa !== undefined && !isPaisa(value.stockValueCostPaisa))) {
    throw new Error('The stock service returned an invalid response.');
  }

  return {
    id: value.id,
    medicine_id: value.medicineId,
    medicine_name: value.medicineName,
    generic_name: value.genericName,
    code: value.medicineCode,
    batch_number: value.batchNumber,
    expiry_date: value.expiryDate,
    received_date: value.receivedDate,
    quantity_remaining: safeInteger(value.quantityRemainingBaseUnits),
    status: value.status,
    min_stock_alert: Number(value.minStockAlert),
    cost_paisa_per_base_unit: value.unitCostPaisaPerBaseUnit == null ? null : paisaString(value.unitCostPaisaPerBaseUnit as string | number),
    mrp_paisa_per_base_unit: paisaString(value.mrpPaisaPerBaseUnit),
    stock_value_cost_paisa: value.stockValueCostPaisa == null ? null : paisaString(value.stockValueCostPaisa as string | number),
    is_sellable: value.isSellable,
  };
}

export async function listStockBatches(query: StockInventoryBatchQuery): Promise<StockInventoryList> {
  const response = await apiRequest<unknown>(queryUrl('/api/stock/batches', {
    tab: query.tab,
    search: query.search,
    sort: query.sort,
    page: query.page,
    pageSize: query.pageSize,
    medicineId: query.medicineId,
    expiryBucket: query.expiryBucket,
  }));
  if (!isRecord(response) || !hasOnlyKeys(response, ['items', 'total', 'page', 'pageSize'])
    || !Array.isArray(response.items)
    || !Number.isSafeInteger(response.total) || Number(response.total) < 0
    || !Number.isSafeInteger(response.page) || !Number.isSafeInteger(response.pageSize)) {
    throw new Error('The stock service returned an invalid response.');
  }
  const rows = response.items.map(parseBatch);
  return {
    rows,
    total_count: Number(response.total),
    page: Number(response.page),
    page_size: Number(response.pageSize),
    can_view_cost: rows.some((row) => row.cost_paisa_per_base_unit !== null),
  };
}

export async function loadStockOverview(): Promise<StockInventoryStats> {
  const response = await apiRequest<unknown>('/api/stock/overview');
  const required = ['stockValueMrpPaisa', 'expiring30', 'expiredBatches'];
  const optional = ['stockValueCostPaisa', 'expiredValueAtRiskPaisa'];
  if (!isRecord(response) || !hasOnlyKeys(response, required, optional)
    || !isPaisa(response.stockValueMrpPaisa)
    || !Number.isSafeInteger(response.expiring30) || Number(response.expiring30) < 0
    || !Number.isSafeInteger(response.expiredBatches) || Number(response.expiredBatches) < 0
    || (response.stockValueCostPaisa !== undefined && !isPaisa(response.stockValueCostPaisa))
    || (response.expiredValueAtRiskPaisa !== undefined && !isPaisa(response.expiredValueAtRiskPaisa))) {
    throw new Error('The stock service returned an invalid response.');
  }
  return {
    stock_value_cost_paisa: response.stockValueCostPaisa == null ? null : paisaString(response.stockValueCostPaisa as string | number),
    stock_value_mrp_paisa: paisaString(response.stockValueMrpPaisa),
    expiring_30: Number(response.expiring30),
    expired_batches: Number(response.expiredBatches),
    expired_value_at_risk_paisa: response.expiredValueAtRiskPaisa == null
      ? null
      : paisaString(response.expiredValueAtRiskPaisa as string | number),
  };
}

export async function loadStockExpiryBuckets(): Promise<{ buckets: StockInventoryExpiryBucket[] }> {
  const response = await apiRequest<unknown>('/api/stock/expiry-buckets');
  const allowedKeys: readonly string[] = ['expired', '0-30', '31-60', '61-90', '90+'];
  if (!isRecord(response) || !hasOnlyKeys(response, ['buckets']) || !Array.isArray(response.buckets)) {
    throw new Error('The stock service returned an invalid response.');
  }
  const buckets = response.buckets.map((bucket): StockInventoryExpiryBucket => {
    if (!isRecord(bucket) || !hasOnlyKeys(bucket, ['key', 'label', 'count', 'quantityRemainingBaseUnits'])
      || !allowedKeys.includes(String(bucket.key)) || !requiredText(bucket.label)
      || !Number.isSafeInteger(bucket.count) || Number(bucket.count) < 0) {
      throw new Error('The stock service returned an invalid response.');
    }
    return {
      key: bucket.key as StockExpiryBucketKey,
      label: bucket.label,
      count: Number(bucket.count),
      quantity_remaining: safeInteger(bucket.quantityRemainingBaseUnits),
    };
  });
  return { buckets };
}

export async function listStockAdjustments(options: {
  page: number;
  pageSize: number;
  reason?: string | null;
  batchId?: string | null;
}): Promise<StockInventoryMovements> {
  const response = await apiRequest<unknown>(queryUrl('/api/stock/adjustments', {
    page: options.page,
    pageSize: options.pageSize,
    reason: options.reason,
    batchId: options.batchId,
  }));
  if (!isRecord(response) || !hasOnlyKeys(response, ['items', 'total', 'page', 'pageSize'])
    || !Array.isArray(response.items)
    || !Number.isSafeInteger(response.total) || Number(response.total) < 0
    || !Number.isSafeInteger(response.page) || !Number.isSafeInteger(response.pageSize)) {
    throw new Error('The stock service returned an invalid response.');
  }
  const rows = response.items.map((item): StockInventoryMovement => {
    if (!isRecord(item) || !hasOnlyKeys(item, [
      'id', 'batchId', 'batchNumber', 'medicineId', 'medicineName', 'genericName',
      'movementType', 'quantityDeltaBaseUnits', 'referenceType', 'referenceId', 'reason',
      'actorName', 'createdAt',
    ]) || !isId(item.id) || !isId(item.batchId) || !requiredText(item.batchNumber)
      || !isId(item.medicineId) || !requiredText(item.medicineName) || !requiredText(item.genericName)
      || !requiredText(item.movementType) || !requiredText(item.reason)
      || !requiredText(item.actorName) || !requiredText(item.createdAt)) {
      throw new Error('The stock service returned an invalid response.');
    }
    const delta = typeof item.quantityDeltaBaseUnits === 'string'
      && /^-?(0|[1-9]\d*)$/.test(item.quantityDeltaBaseUnits)
      ? Number(item.quantityDeltaBaseUnits)
      : item.quantityDeltaBaseUnits;
    if (!Number.isSafeInteger(delta)) throw new Error('The stock service returned an invalid response.');
    return {
      id: item.id,
      batch_id: item.batchId,
      batch_number: item.batchNumber,
      medicine_id: item.medicineId,
      medicine_name: item.medicineName,
      generic_name: item.genericName,
      movement_type: item.movementType,
      quantity_delta: Number(delta),
      reason: item.reason,
      created_at: item.createdAt,
      actor_name: item.actorName,
    };
  });
  return {
    rows,
    total_count: Number(response.total),
    page: Number(response.page),
    page_size: Number(response.pageSize),
  };
}

export async function adjustStockBatch(id: string, deltaBaseUnits: number, reason: string): Promise<number> {
  const response = await apiRequest<unknown>(`/api/stock/batches/${encodeURIComponent(id)}/adjust`, {
    method: 'POST',
    body: JSON.stringify({ deltaBaseUnits: String(deltaBaseUnits), reason }),
  });
  if (!isRecord(response) || !hasOnlyKeys(response, ['id', 'quantityRemainingBaseUnits', 'status'], ['quantityBeforeBaseUnits'])
    || response.id !== id || typeof response.status !== 'string') {
    throw new Error('The stock service returned an invalid response.');
  }
  return safeInteger(response.quantityRemainingBaseUnits);
}

export async function writeOffExpiredBatch(id: string): Promise<void> {
  const response = await apiRequest<unknown>(`/api/stock/batches/${encodeURIComponent(id)}/write-off`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'expired' }),
  });
  if (!isRecord(response) || !hasOnlyKeys(response, [
    'id', 'quantityBeforeBaseUnits', 'quantityRemainingBaseUnits', 'status',
  ]) || response.id !== id || typeof response.status !== 'string'
    || safeInteger(response.quantityRemainingBaseUnits) !== 0
    || safeInteger(response.quantityBeforeBaseUnits) <= 0) {
    throw new Error('The stock service returned an invalid response.');
  }
}
