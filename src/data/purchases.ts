import { apiRequest } from '../api';

export interface PurchaseCatalogUnit {
  id: string;
  name: string;
  conversion_factor: number;
  is_default_sale_unit: boolean;
  price_paisa: number;
}

export interface PurchaseCatalogProduct {
  id: string;
  code: string;
  barcode: string | null;
  brand_name: string;
  generic_name: string;
  company: string;
  stock: number;
  last_cost_base_paisa: number | null;
  units: PurchaseCatalogUnit[];
}

export interface PurchaseSupplier {
  id: string;
  name: string;
}

export interface PurchaseCatalog {
  products: PurchaseCatalogProduct[];
  suppliers: PurchaseSupplier[];
  today: string;
}

export interface PurchaseWriteInput {
  supplierId: string;
  invoiceNumber: string;
  purchaseDate: string;
  paymentType: 'cash' | 'credit';
  discountPaisa: string;
  notes: string;
  items: Array<{
    medicineId: string;
    unitId: string;
    batchNumber: string;
    expiryDate: string;
    quantity: number;
    bonusQuantity: number;
    unitCostPaisa: string;
    mrpPaisa: string;
  }>;
}

export interface PurchaseHistoryItem {
  medicine_id: string;
  product_name: string;
  generic_name: string;
  unit_name: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  bonus_qty: number;
  conversion_factor: number;
  unit_cost_paisa?: number;
  mrp_paisa?: number;
  line_total_paisa?: number;
}

export interface PurchaseHistoryRow {
  id: string;
  pr_no: string;
  supplier_name: string;
  invoice_number: string | null;
  purchase_date: string;
  subtotal_paisa?: number;
  discount_paisa?: number;
  total_paisa?: number;
  paid_paisa?: number;
  due_paisa?: number;
  payment_type: 'cash' | 'credit';
  status: 'posted' | 'void';
  notes: string | null;
  void_reason: string | null;
  created_by: string;
  created_at: string;
  item_count: number;
  items?: PurchaseHistoryItem[];
}

export interface PurchaseHistoryResult {
  rows: PurchaseHistoryRow[];
  total_count: number;
  summary: {
    total_paisa: number;
    cash_paisa: number;
    cash_count: number;
    credit_paisa: number;
    credit_count: number;
  } | null;
  page: number;
  page_size: number;
  costVisible: boolean;
}

export interface PurchaseDetail extends PurchaseHistoryRow {
  supplier_contact: string;
  supplier_address: string;
  items: PurchaseHistoryItem[];
}

export interface PurchasePosted {
  id: string;
  pr_no: string;
  total_paisa: number;
}

export interface PurchaseHistoryQuery {
  search?: string;
  paymentType?: 'cash' | 'credit';
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
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

function isDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function safeNumber(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('The purchase service returned an invalid response.');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('The purchase service returned an invalid response.');
  return number;
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error('The purchase service returned an invalid response.');
  }
  return Number(value);
}

function requiredText(value: unknown): value is string {
  return typeof value === 'string';
}

function parseCatalogUnit(value: unknown): PurchaseCatalogUnit {
  const keys = ['id', 'name', 'conversionFactorBaseUnits', 'isDefaultSaleUnit', 'pricePaisa'];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)
    || !isId(value.id) || !requiredText(value.name)
    || !Number.isSafeInteger(value.conversionFactorBaseUnits) || Number(value.conversionFactorBaseUnits) < 1
    || typeof value.isDefaultSaleUnit !== 'boolean') {
    throw new Error('The purchase service returned an invalid response.');
  }
  return {
    id: value.id,
    name: value.name,
    conversion_factor: Number(value.conversionFactorBaseUnits),
    is_default_sale_unit: value.isDefaultSaleUnit,
    price_paisa: safeNumber(value.pricePaisa),
  };
}

function parseCatalogProduct(value: unknown): PurchaseCatalogProduct {
  const required = ['id', 'code', 'barcode', 'name', 'genericName', 'manufacturer', 'stockBaseUnits', 'units'];
  const optional = ['lastCostPaisaPerBaseUnit'];
  if (!isRecord(value) || !hasOnlyKeys(value, required, optional)
    || !isId(value.id) || !requiredText(value.code) || !(value.barcode === null || requiredText(value.barcode))
    || !requiredText(value.name) || !requiredText(value.genericName) || !requiredText(value.manufacturer)
    || !Array.isArray(value.units)
    || ('lastCostPaisaPerBaseUnit' in value
      && value.lastCostPaisaPerBaseUnit !== null
      && (typeof value.lastCostPaisaPerBaseUnit !== 'string'
        || !/^(0|[1-9]\d*)$/.test(value.lastCostPaisaPerBaseUnit)))) {
    throw new Error('The purchase service returned an invalid response.');
  }
  return {
    id: value.id,
    code: value.code,
    barcode: value.barcode,
    brand_name: value.name,
    generic_name: value.genericName,
    company: value.manufacturer,
    stock: safeNumber(value.stockBaseUnits),
    last_cost_base_paisa: value.lastCostPaisaPerBaseUnit == null
      ? null
      : safeNumber(value.lastCostPaisaPerBaseUnit),
    units: value.units.map(parseCatalogUnit),
  };
}

function parsePurchaseCatalog(value: unknown): PurchaseCatalog {
  if (!isRecord(value) || !hasOnlyKeys(value, ['items', 'suppliers', 'today'])
    || !Array.isArray(value.items) || !Array.isArray(value.suppliers) || !isDate(value.today)) {
    throw new Error('The purchase service returned an invalid response.');
  }
  const suppliers = value.suppliers.map((supplier) => {
    if (!isRecord(supplier) || !hasOnlyKeys(supplier, ['id', 'name', 'contact'])
      || !isId(supplier.id) || !requiredText(supplier.name) || !requiredText(supplier.contact)) {
      throw new Error('The purchase service returned an invalid response.');
    }
    return { id: supplier.id, name: supplier.name };
  });
  return {
    products: value.items.map(parseCatalogProduct),
    suppliers,
    today: value.today,
  };
}

function parseHistoryItem(value: unknown): PurchaseHistoryItem {
  const required = [
    'id', 'medicineId', 'medicineName', 'medicineCode', 'unitId', 'unitName',
    'conversionFactorBaseUnits', 'quantity', 'bonusQuantityBaseUnits',
    'quantityReceivedBaseUnits', 'batchId', 'batchNumber', 'expiryDate',
  ];
  const optional = ['unitCostPaisa', 'mrpPaisa', 'lineTotalPaisa'];
  if (!isRecord(value) || !hasOnlyKeys(value, required, optional)
    || !isId(value.id) || !isId(value.medicineId) || !requiredText(value.medicineName)
    || !requiredText(value.medicineCode) || !isId(value.unitId) || !requiredText(value.unitName)
    || !Number.isSafeInteger(value.conversionFactorBaseUnits) || Number(value.conversionFactorBaseUnits) < 1
    || !Number.isSafeInteger(value.quantity) || Number(value.quantity) < 1
    || !isId(value.batchId) || !requiredText(value.batchNumber) || !isDate(value.expiryDate)) {
    throw new Error('The purchase service returned an invalid response.');
  }
  const factor = Number(value.conversionFactorBaseUnits);
  const bonusBaseUnits = safeNumber(value.bonusQuantityBaseUnits);
  safeNumber(value.quantityReceivedBaseUnits);
  if (bonusBaseUnits % factor !== 0) throw new Error('The purchase service returned an invalid response.');
  const costs = ['unitCostPaisa', 'mrpPaisa', 'lineTotalPaisa'] as const;
  const costCount = costs.filter((key) => key in value).length;
  if (costCount !== 0 && costCount !== costs.length) throw new Error('The purchase service returned an invalid response.');
  return {
    medicine_id: value.medicineId,
    product_name: value.medicineName,
    generic_name: '',
    unit_name: value.unitName,
    batch_number: value.batchNumber,
    expiry_date: value.expiryDate,
    quantity: Number(value.quantity),
    bonus_qty: bonusBaseUnits / factor,
    conversion_factor: factor,
    ...(costCount === 3 ? {
      unit_cost_paisa: safeNumber(value.unitCostPaisa),
      mrp_paisa: safeNumber(value.mrpPaisa),
      line_total_paisa: safeNumber(value.lineTotalPaisa),
    } : {}),
  };
}

function parseHistoryRow(value: unknown): PurchaseHistoryRow {
  const base = [
    'id', 'purchaseNumber', 'supplierId', 'supplierName', 'invoiceNumber',
    'purchaseDate', 'status', 'paymentType', 'itemCount', 'createdByName', 'createdAt',
  ];
  const costKeys = ['subtotalPaisa', 'discountPaisa', 'totalPaisa', 'paidPaisa'];
  if (!isRecord(value) || !hasOnlyKeys(value, base, costKeys)
    || !isId(value.id) || !requiredText(value.purchaseNumber)
    || !isId(value.supplierId) || !requiredText(value.supplierName)
    || !(value.invoiceNumber === null || requiredText(value.invoiceNumber))
    || !isDate(value.purchaseDate) || !['posted', 'void'].includes(String(value.status))
    || !['cash', 'credit'].includes(String(value.paymentType))
    || !Number.isSafeInteger(value.itemCount) || Number(value.itemCount) < 0
    || !requiredText(value.createdByName) || typeof value.createdAt !== 'string'
    || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error('The purchase service returned an invalid response.');
  }
  const costCount = costKeys.filter((key) => key in value).length;
  if (costCount !== 0 && costCount !== costKeys.length) throw new Error('The purchase service returned an invalid response.');
  const subtotal = costCount === 4 ? safeNumber(value.subtotalPaisa) : undefined;
  const discount = costCount === 4 ? safeNumber(value.discountPaisa) : undefined;
  const total = costCount === 4 ? safeNumber(value.totalPaisa) : undefined;
  const paid = costCount === 4 ? safeNumber(value.paidPaisa) : undefined;
  return {
    id: value.id,
    pr_no: value.purchaseNumber,
    supplier_name: value.supplierName,
    invoice_number: value.invoiceNumber === '' ? null : value.invoiceNumber,
    purchase_date: value.purchaseDate,
    ...(costCount === 4 ? {
      subtotal_paisa: subtotal,
      discount_paisa: discount,
      total_paisa: total,
      paid_paisa: paid,
      due_paisa: Math.max((total ?? 0) - (paid ?? 0), 0),
    } : {}),
    payment_type: value.paymentType as 'cash' | 'credit',
    status: value.status as 'posted' | 'void',
    notes: null,
    void_reason: null,
    created_by: value.createdByName,
    created_at: value.createdAt,
    item_count: Number(value.itemCount),
  };
}

function parseSummary(value: unknown): NonNullable<PurchaseHistoryResult['summary']> {
  const keys = ['totalPaisa', 'cashPaisa', 'cashCount', 'creditPaisa', 'creditCount'];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)
    || !Number.isSafeInteger(value.cashCount) || Number(value.cashCount) < 0
    || !Number.isSafeInteger(value.creditCount) || Number(value.creditCount) < 0) {
    throw new Error('The purchase service returned an invalid response.');
  }
  return {
    total_paisa: safeNumber(value.totalPaisa),
    cash_paisa: safeNumber(value.cashPaisa),
    cash_count: Number(value.cashCount),
    credit_paisa: safeNumber(value.creditPaisa),
    credit_count: Number(value.creditCount),
  };
}

function parseHistory(value: unknown, page: number, pageSize: number): PurchaseHistoryResult {
  const required = ['items', 'total', 'page', 'pageSize'];
  if (!isRecord(value) || !hasOnlyKeys(value, required, ['summary'])
    || !Array.isArray(value.items) || !Number.isSafeInteger(value.total) || Number(value.total) < 0
    || value.page !== page || value.pageSize !== pageSize) {
    throw new Error('The purchase service returned an invalid response.');
  }
  const summary = 'summary' in value ? parseSummary(value.summary) : null;
  return {
    rows: value.items.map(parseHistoryRow),
    total_count: Number(value.total),
    summary,
    page,
    page_size: pageSize,
    costVisible: summary !== null,
  };
}

function parsePurchaseDetail(value: unknown): PurchaseDetail {
  const base = [
    'id', 'purchaseNumber', 'supplierId', 'supplierName', 'invoiceNumber',
    'purchaseDate', 'status', 'paymentType', 'itemCount', 'createdByName',
    'createdAt', 'notes', 'items',
  ];
  const optional = ['subtotalPaisa', 'discountPaisa', 'totalPaisa', 'paidPaisa', 'voidReason', 'voidedAt'];
  if (!isRecord(value) || !hasOnlyKeys(value, base, optional)
    || !Array.isArray(value.items) || typeof value.notes !== 'string'
    || ('voidReason' in value && typeof value.voidReason !== 'string')
    || ('voidedAt' in value && (typeof value.voidedAt !== 'string' || Number.isNaN(Date.parse(value.voidedAt))))) {
    throw new Error('The purchase service returned an invalid response.');
  }
  const historyKeys = [
    'id', 'purchaseNumber', 'supplierId', 'supplierName', 'invoiceNumber',
    'purchaseDate', 'status', 'paymentType', 'itemCount', 'createdByName', 'createdAt',
    ...['subtotalPaisa', 'discountPaisa', 'totalPaisa', 'paidPaisa'].filter((key) => key in value),
  ];
  const row = parseHistoryRow(Object.fromEntries(
    historyKeys.filter((key) => key in value).map((key) => [key, value[key]]),
  ));
  const items = value.items.map(parseHistoryItem);
  const costVisible = 'subtotalPaisa' in value;
  if (items.some((item) => (item.unit_cost_paisa !== undefined) !== costVisible)
    || (items.length !== Number(value.itemCount))) {
    throw new Error('The purchase service returned an invalid response.');
  }
  return {
    ...row,
    supplier_contact: '',
    supplier_address: '',
    notes: value.notes,
    void_reason: typeof value.voidReason === 'string' ? value.voidReason : null,
    items,
  };
}

export async function loadPurchaseCatalog(): Promise<PurchaseCatalog> {
  return parsePurchaseCatalog(await apiRequest<unknown>('/api/purchases/catalog'));
}

export async function postPurchase(input: PurchaseWriteInput): Promise<PurchasePosted> {
  const detail = parsePurchaseDetail(await apiRequest<unknown>('/api/purchases', {
    method: 'POST',
    body: JSON.stringify(input),
  }));
  if (detail.total_paisa === undefined) throw new Error('The purchase service returned an invalid response.');
  return { id: detail.id, pr_no: detail.pr_no, total_paisa: detail.total_paisa };
}

function historyUrl(query: PurchaseHistoryQuery): string {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.search) params.set('search', query.search);
  if (query.paymentType) params.set('paymentType', query.paymentType);
  if (query.dateFrom) params.set('dateFrom', query.dateFrom);
  if (query.dateTo) params.set('dateTo', query.dateTo);
  return `/api/purchases/history?${params.toString()}`;
}

export async function loadPurchaseHistory(query: PurchaseHistoryQuery): Promise<PurchaseHistoryResult> {
  return parseHistory(await apiRequest<unknown>(historyUrl(query)), query.page, query.pageSize);
}

export async function loadPurchaseDetail(id: string): Promise<PurchaseDetail> {
  return parsePurchaseDetail(await apiRequest<unknown>(`/api/purchases/${encodeURIComponent(id)}`));
}

export async function voidPurchase(id: string, reason: string): Promise<PurchaseDetail> {
  return parsePurchaseDetail(await apiRequest<unknown>(`/api/purchases/${encodeURIComponent(id)}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  }));
}

export async function loadPurchaseExport(
  query: Omit<PurchaseHistoryQuery, 'page' | 'pageSize'>,
): Promise<PurchaseDetail[]> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.paymentType) params.set('paymentType', query.paymentType);
  if (query.dateFrom) params.set('dateFrom', query.dateFrom);
  if (query.dateTo) params.set('dateTo', query.dateTo);
  const response = await apiRequest<unknown>(`/api/purchases/export?${params.toString()}`);
  if (!isRecord(response) || !hasOnlyKeys(response, ['items']) || !Array.isArray(response.items)) {
    throw new Error('The purchase service returned an invalid response.');
  }
  const purchases = response.items.map(parsePurchaseDetail);
  if (purchases.some((purchase) => purchase.total_paisa === undefined
    || purchase.items.some((item) => item.unit_cost_paisa === undefined))) {
    throw new Error('The purchase service returned an invalid response.');
  }
  return purchases;
}
