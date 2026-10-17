import { apiRequest, getBackend } from '../api';
import { loadMasterDataOverview, loadMasterDataUnits } from './masterData';
import { listStockBatches, type StockInventoryBatch } from './stockInventory';

export interface ProductUnit {
  id: string;
  name: string;
  conversion_factor: number;
  is_default_sale_unit: boolean;
  price_paisa: number;
  barcode: string | null;
}

export interface ProductMedicine {
  id: string;
  code: string;
  barcode: string | null;
  brand_name: string;
  generic_name: string;
  strength: string | null;
  category: string;
  company: string;
  drug_class: 'OTC' | 'RX' | 'CONTROLLED' | 'NARCOTIC';
  storage_condition: 'ROOM_TEMPERATURE' | 'COOL' | 'COLD_REFRIGERATED';
  rack_location: string;
  min_stock_alert: number;
  requires_prescription: boolean;
  is_active: boolean;
  units: ProductUnit[];
  stock: number;
  latest_cost_paisa: number | null;
  margin_percent: string | null;
  nearest_expiry: string | null;
  mrp_paisa: number;
  default_unit_conversion: number;
}

export interface ProductOption {
  id: string;
  name: string;
}

export interface ProductOverviewStats {
  total_active: number;
  low_stock: number;
  out_of_stock: number;
  expiring_90: number;
  stock_value_cost_paisa: string | null;
}

export interface ProductCatalogQuery {
  page: number;
  pageSize: number;
  search: string;
  categoryId?: string;
  brandId?: string;
  drugClass?: string;
  active: 'true' | 'false' | 'all';
  lowStockOnly: boolean;
  sort: 'name' | 'stock' | 'expiry' | 'mrp';
  order: 'asc' | 'desc';
}

export interface ProductCatalogPage {
  rows: ProductMedicine[];
  total: number;
  canViewCost: boolean;
  stats: ProductOverviewStats;
}

export interface ProductUnitInput {
  id?: string;
  name: string;
  conversionFactorBaseUnits: number;
  isDefaultSaleUnit: boolean;
  pricePaisa: number;
  barcode: string | null;
}

export interface ProductInput {
  id: string | null;
  code: string;
  barcode: string | null;
  name: string;
  genericName: string;
  strength: string | null;
  categoryId: string;
  brandId: string;
  drugClass: ProductMedicine['drug_class'];
  storageCondition: ProductMedicine['storage_condition'];
  rackLocation: string;
  minStockAlert: number;
  requiresPrescription: boolean;
  isActive: boolean;
  units: ProductUnitInput[];
  existingUnitIds: string[];
}

interface ApiMedicine {
  id: string;
  code: string;
  barcode?: string | null;
  name: string;
  genericName?: string;
  strength?: string;
  categoryId?: string;
  brandId?: string;
  drugClass: ProductMedicine['drug_class'];
  storageCondition: ProductMedicine['storage_condition'];
  rackLocation?: string;
  minStockAlert: number;
  requiresPrescription: boolean;
  isActive: boolean;
  categoryName?: string;
  brandName?: string;
  defaultUnitName?: string;
  defaultUnitConversionFactor?: number;
  defaultUnitPricePaisa?: string;
  latestCostPaisa?: string | null;
  marginBasisPoints?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MedicinePage {
  items: ApiMedicine[];
  page: number;
  pageSize: number;
  total: number;
}

const MEDICINE_KEYS = [
  'id', 'code', 'name', 'drugClass', 'storageCondition', 'minStockAlert',
  'requiresPrescription', 'isActive', 'createdAt', 'updatedAt',
] as const;
const MEDICINE_OPTIONAL_KEYS = [
  'barcode', 'genericName', 'strength', 'categoryId', 'brandId', 'rackLocation',
  'categoryName', 'brandName', 'defaultUnitName', 'defaultUnitConversionFactor',
  'defaultUnitPricePaisa', 'latestCostPaisa', 'marginBasisPoints',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safePaisa(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('The product service returned an invalid response.');
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('The product service returned an invalid response.');
  return result;
}

function isDrugClass(value: unknown): value is ProductMedicine['drug_class'] {
  return value === 'OTC' || value === 'RX' || value === 'CONTROLLED' || value === 'NARCOTIC';
}

function isStorageCondition(value: unknown): value is ProductMedicine['storage_condition'] {
  return value === 'ROOM_TEMPERATURE' || value === 'COOL' || value === 'COLD_REFRIGERATED';
}

function parseMedicine(value: unknown): ApiMedicine {
  if (!isRecord(value) || !hasOnlyKeys(value, MEDICINE_KEYS, MEDICINE_OPTIONAL_KEYS)
    || typeof value.id !== 'string' || !/^[a-f\d]{24}$/i.test(value.id)
    || typeof value.code !== 'string' || typeof value.name !== 'string'
    || !isDrugClass(value.drugClass)
    || !isStorageCondition(value.storageCondition)
    || !safeCount(value.minStockAlert)
    || typeof value.requiresPrescription !== 'boolean' || typeof value.isActive !== 'boolean'
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string'
    || (value.barcode !== undefined && value.barcode !== null && typeof value.barcode !== 'string')
    || (value.genericName !== undefined && typeof value.genericName !== 'string')
    || (value.strength !== undefined && typeof value.strength !== 'string')
    || (value.categoryId !== undefined && typeof value.categoryId !== 'string')
    || (value.brandId !== undefined && typeof value.brandId !== 'string')
    || (value.rackLocation !== undefined && typeof value.rackLocation !== 'string')
    || (value.categoryName !== undefined && typeof value.categoryName !== 'string')
    || (value.brandName !== undefined && typeof value.brandName !== 'string')
    || (value.defaultUnitName !== undefined && typeof value.defaultUnitName !== 'string')
    || (value.defaultUnitConversionFactor !== undefined
      && (!safeCount(value.defaultUnitConversionFactor) || value.defaultUnitConversionFactor < 1))
    || (value.defaultUnitPricePaisa !== undefined && !/^(0|[1-9]\d*)$/.test(String(value.defaultUnitPricePaisa)))
    || (value.latestCostPaisa !== undefined
      && value.latestCostPaisa !== null
      && !/^(0|[1-9]\d*)$/.test(String(value.latestCostPaisa)))
    || (value.marginBasisPoints !== undefined
      && value.marginBasisPoints !== null
      && !/^-?(0|[1-9]\d*)$/.test(String(value.marginBasisPoints)))
    || (value.marginBasisPoints !== undefined && !Object.hasOwn(value, 'latestCostPaisa'))) {
    throw new Error('The product service returned an invalid response.');
  }
  if (value.defaultUnitPricePaisa !== undefined) safePaisa(value.defaultUnitPricePaisa);
  if (value.latestCostPaisa !== undefined && value.latestCostPaisa !== null) safePaisa(value.latestCostPaisa);
  return {
    id: String(value.id),
    code: String(value.code),
    name: String(value.name),
    drugClass: value.drugClass,
    storageCondition: value.storageCondition,
    minStockAlert: Number(value.minStockAlert),
    requiresPrescription: value.requiresPrescription,
    isActive: value.isActive,
    createdAt: String(value.createdAt),
    updatedAt: String(value.updatedAt),
    ...(value.barcode === undefined ? {} : { barcode: typeof value.barcode === 'string' ? value.barcode : null }),
    ...(value.genericName === undefined ? {} : { genericName: String(value.genericName) }),
    ...(value.strength === undefined ? {} : { strength: String(value.strength) }),
    ...(value.categoryId === undefined ? {} : { categoryId: String(value.categoryId) }),
    ...(value.brandId === undefined ? {} : { brandId: String(value.brandId) }),
    ...(value.rackLocation === undefined ? {} : { rackLocation: String(value.rackLocation) }),
    ...(value.categoryName === undefined ? {} : { categoryName: String(value.categoryName) }),
    ...(value.brandName === undefined ? {} : { brandName: String(value.brandName) }),
    ...(value.defaultUnitName === undefined ? {} : { defaultUnitName: String(value.defaultUnitName) }),
    ...(value.defaultUnitConversionFactor === undefined
      ? {}
      : { defaultUnitConversionFactor: Number(value.defaultUnitConversionFactor) }),
    ...(value.defaultUnitPricePaisa === undefined
      ? {}
      : { defaultUnitPricePaisa: String(value.defaultUnitPricePaisa) }),
    ...(value.latestCostPaisa === undefined
      ? {}
      : { latestCostPaisa: value.latestCostPaisa === null ? null : String(value.latestCostPaisa) }),
    ...(value.marginBasisPoints === undefined
      ? {}
      : { marginBasisPoints: value.marginBasisPoints === null ? null : String(value.marginBasisPoints) }),
  };
}

function parseMedicinePage(value: unknown): MedicinePage {
  if (!isRecord(value) || !hasOnlyKeys(value, ['items', 'page', 'pageSize', 'total'])
    || !Array.isArray(value.items) || !safeCount(value.page) || value.page < 1
    || !safeCount(value.pageSize) || value.pageSize < 1 || !safeCount(value.total)) {
    throw new Error('The product service returned an invalid response.');
  }
  return {
    items: value.items.map(parseMedicine),
    page: value.page,
    pageSize: value.pageSize,
    total: value.total,
  };
}

function medicineQueryUrl(query: ProductCatalogQuery, page: number, pageSize: number): string {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    active: query.active,
    order: query.order,
  });
  if (query.search.trim()) params.set('search', query.search.trim());
  if (query.categoryId) params.set('categoryId', query.categoryId);
  if (query.brandId) params.set('brandId', query.brandId);
  if (query.drugClass) params.set('drugClass', query.drugClass);
  params.set('sort', 'name');
  return `/api/medicines?${params.toString()}`;
}

async function fetchMedicinePage(query: ProductCatalogQuery, page: number, pageSize: number): Promise<MedicinePage> {
  return parseMedicinePage(await apiRequest<unknown>(medicineQueryUrl(query, page, pageSize)));
}

async function fetchAllMedicines(query: ProductCatalogQuery): Promise<ApiMedicine[]> {
  if (query.drugClass === 'CONTROLLED') {
    const [controlled, narcotic] = await Promise.all([
      fetchAllMedicines({ ...query, drugClass: 'CONTROLLED' }),
      fetchAllMedicines({ ...query, drugClass: 'NARCOTIC' }),
    ]);
    return [...controlled, ...narcotic].sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }
  const pageSize = 200;
  const first = await fetchMedicinePage(query, 1, pageSize);
  const rows = first.items.slice();
  for (let page = 2; rows.length < first.total; page += 1) {
    const next = await fetchMedicinePage(query, page, pageSize);
    if (next.items.length === 0) throw new Error('The product service returned an incomplete page.');
    rows.push(...next.items);
  }
  return rows;
}

async function loadMedicineBatches(medicineId: string): Promise<StockInventoryBatch[]> {
  const pageSize = 500;
  const first = await listStockBatches({
    tab: 'all',
    search: '',
    sort: 'expiry_asc',
    page: 1,
    pageSize,
    medicineId,
    expiryBucket: null,
  });
  const rows = first.rows.slice();
  for (let page = 2; rows.length < first.total_count; page += 1) {
    const next = await listStockBatches({
      tab: 'all',
      search: '',
      sort: 'expiry_asc',
      page,
      pageSize,
      medicineId,
      expiryBucket: null,
    });
    if (next.rows.length === 0) throw new Error('The stock service returned an incomplete page.');
    rows.push(...next.rows);
  }
  return rows;
}

async function loadAllStockBatches(): Promise<StockInventoryBatch[]> {
  const pageSize = 500;
  const first = await listStockBatches({
    tab: 'all', search: '', sort: 'expiry_asc', page: 1, pageSize, medicineId: null, expiryBucket: null,
  });
  const rows = first.rows.slice();
  for (let page = 2; rows.length < first.total_count; page += 1) {
    const next = await listStockBatches({
      tab: 'all', search: '', sort: 'expiry_asc', page, pageSize, medicineId: null, expiryBucket: null,
    });
    if (next.rows.length === 0) throw new Error('The stock service returned an incomplete page.');
    rows.push(...next.rows);
  }
  return rows;
}

export async function loadLowStockProductIds(): Promise<Set<string>> {
  const pageSize = 500;
  const first = await listStockBatches({
    tab: 'low-stock', search: '', sort: 'medicine_asc', page: 1, pageSize, medicineId: null, expiryBucket: null,
  });
  const rows = first.rows.slice();
  for (let page = 2; rows.length < first.total_count; page += 1) {
    const next = await listStockBatches({
      tab: 'low-stock', search: '', sort: 'medicine_asc', page, pageSize, medicineId: null, expiryBucket: null,
    });
    if (next.rows.length === 0) throw new Error('The stock service returned an incomplete low-stock page.');
    rows.push(...next.rows);
  }
  return new Set(rows.map((row) => row.medicine_id));
}

function stockByMedicine(batches: readonly StockInventoryBatch[]): Map<string, { quantity: number; expiry: string | null }> {
  const result = new Map<string, { quantity: number; expiry: string | null }>();
  for (const batch of batches) {
    if (!batch.is_sellable) continue;
    const current = result.get(batch.medicine_id) ?? { quantity: 0, expiry: null };
    const quantity = current.quantity + batch.quantity_remaining;
    if (!Number.isSafeInteger(quantity)) throw new Error('The stock service returned an unsupported quantity total.');
    current.quantity = quantity;
    if (current.expiry === null || batch.expiry_date < current.expiry) current.expiry = batch.expiry_date;
    result.set(batch.medicine_id, current);
  }
  return result;
}

function percentFromBasisPoints(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const basisPoints = BigInt(value);
  const sign = basisPoints < 0n ? '-' : '';
  const absolute = basisPoints < 0n ? -basisPoints : basisPoints;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function toProduct(medicine: ApiMedicine, units: ProductUnit[], stock: { quantity: number; expiry: string | null }): ProductMedicine {
  const defaultUnit = units.find((unit) => unit.is_default_sale_unit);
  const conversion = defaultUnit?.conversion_factor ?? medicine.defaultUnitConversionFactor ?? 1;
  const price = defaultUnit?.price_paisa ?? (medicine.defaultUnitPricePaisa ? safePaisa(medicine.defaultUnitPricePaisa) : 0);
  const baseCost = medicine.latestCostPaisa == null ? null : safePaisa(medicine.latestCostPaisa);
  return {
    id: medicine.id,
    code: medicine.code,
    barcode: medicine.barcode ?? null,
    brand_name: medicine.name,
    generic_name: medicine.genericName ?? '',
    strength: medicine.strength ?? null,
    category: medicine.categoryName ?? '',
    company: medicine.brandName ?? '',
    drug_class: medicine.drugClass,
    storage_condition: medicine.storageCondition,
    rack_location: medicine.rackLocation ?? '',
    min_stock_alert: medicine.minStockAlert,
    requires_prescription: medicine.requiresPrescription,
    is_active: medicine.isActive,
    units,
    stock: stock.quantity,
    latest_cost_paisa: baseCost,
    margin_percent: percentFromBasisPoints(medicine.marginBasisPoints),
    nearest_expiry: stock.expiry,
    mrp_paisa: price,
    default_unit_conversion: conversion,
  };
}

function parsePaisaTotal(value: unknown): bigint | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('The product summary service returned an invalid response.');
  }
  return BigInt(value);
}

export async function loadProductOptions(): Promise<{ categories: ProductOption[]; brands: ProductOption[] }> {
  const overview = await loadMasterDataOverview();
  return {
    categories: overview.categories.filter((item) => item.is_active).map(({ id, name }) => ({ id, name })),
    brands: overview.manufacturers.filter((item) => item.is_active).map(({ id, name }) => ({ id, name })),
  };
}

export async function loadProductCatalog(query: ProductCatalogQuery): Promise<ProductCatalogPage> {
  if (getBackend() !== 'api') throw new Error('Product API data is only available in API mode.');
  const needsAllRows = query.lowStockOnly || query.sort !== 'name' || query.drugClass === 'CONTROLLED';
  const [listing, master, activePage, units, allBatches, lowStockIds] = await Promise.all([
    needsAllRows
      ? fetchAllMedicines(query).then((items) => ({ items, total: items.length }))
      : fetchMedicinePage(query, query.page, query.pageSize).then(({ items, total }) => ({ items, total })),
    loadMasterDataOverview(),
    fetchMedicinePage({
      page: 1,
      pageSize: 1,
      search: '',
      active: 'true',
      lowStockOnly: false,
      sort: 'name',
      order: 'asc',
    }, 1, 1),
    loadMasterDataUnits(),
    needsAllRows ? loadAllStockBatches() : Promise.resolve(null),
    query.lowStockOnly ? loadLowStockProductIds() : Promise.resolve(null),
  ]);
  const medicineRows = listing.items;

  const unitsByMedicine = new Map<string, ProductUnit[]>();
  for (const unit of units) {
    const mapped: ProductUnit = {
      id: unit.id,
      name: unit.name,
      conversion_factor: unit.conversion_factor,
      is_default_sale_unit: unit.is_default_sale_unit,
      price_paisa: unit.price_paisa,
      barcode: unit.barcode,
    };
    const current = unitsByMedicine.get(unit.medicine_id) ?? [];
    current.push(mapped);
    unitsByMedicine.set(unit.medicine_id, current);
  }

  if (needsAllRows && allBatches) {
    const stockMap = stockByMedicine(allBatches);
    let products = medicineRows.map((medicine) => toProduct(
      medicine,
      unitsByMedicine.get(medicine.id) ?? [],
      stockMap.get(medicine.id) ?? { quantity: 0, expiry: null },
    ));
    if (query.lowStockOnly) {
      products = products.filter((product) => lowStockIds?.has(product.id) ?? false);
    }
    const field = {
      name: 'brand_name',
      stock: 'stock',
      expiry: 'nearest_expiry',
      mrp: 'mrp_paisa',
    }[query.sort] as 'brand_name' | 'stock' | 'nearest_expiry' | 'mrp_paisa';
    products.sort((left, right) => {
      const leftValue = left[field];
      const rightValue = right[field];
      const compared = leftValue === null
        ? (rightValue === null ? 0 : 1)
        : rightValue === null
          ? -1
          : typeof leftValue === 'number' && typeof rightValue === 'number'
            ? leftValue - rightValue
            : String(leftValue).localeCompare(String(rightValue));
      return (query.order === 'asc' ? compared : -compared) || left.id.localeCompare(right.id);
    });
    const total = products.length;
    const overview = master.categories;
    const costTotals = overview.map((item) => parsePaisaTotal(item.stock_value_paisa));
    const costVisible = medicineRows.some((medicine) => Object.hasOwn(medicine, 'latestCostPaisa'))
      || costTotals.some((value) => value !== null);
    const totalCost = costVisible
      ? costTotals.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n).toString()
      : null;
    return {
      rows: products.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total,
      canViewCost: costVisible,
      stats: {
        total_active: activePage.total,
        low_stock: overview.reduce((sum, item) => sum + item.low_count, 0),
        out_of_stock: overview.reduce((sum, item) => sum + item.out_count, 0),
        expiring_90: overview.reduce((sum, item) => sum + item.expiring_count, 0),
        stock_value_cost_paisa: totalCost,
      },
    };
  }

  const stockResults = await Promise.all(medicineRows.map((medicine) => loadMedicineBatches(medicine.id)));
  const stockMap = stockByMedicine(stockResults.flat());
  const rows = medicineRows.map((medicine) => toProduct(
    medicine,
    unitsByMedicine.get(medicine.id) ?? [],
    stockMap.get(medicine.id) ?? { quantity: 0, expiry: null },
  ));
  const costTotals = master.categories.map((item) => parsePaisaTotal(item.stock_value_paisa));
  const costVisible = medicineRows.some((medicine) => Object.hasOwn(medicine, 'latestCostPaisa'))
    || costTotals.some((value) => value !== null);
  return {
    rows,
    total: listing.total,
    canViewCost: costVisible,
    stats: {
      total_active: activePage.total,
      low_stock: master.categories.reduce((sum, item) => sum + item.low_count, 0),
      out_of_stock: master.categories.reduce((sum, item) => sum + item.out_count, 0),
      expiring_90: master.categories.reduce((sum, item) => sum + item.expiring_count, 0),
      stock_value_cost_paisa: costVisible
        ? costTotals.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n).toString()
        : null,
    },
  };
}

export async function loadAllProductsForExport(query: ProductCatalogQuery): Promise<ProductMedicine[]> {
  const all = await fetchAllMedicines(query);
  const [units, batches] = await Promise.all([loadMasterDataUnits(), loadAllStockBatches()]);
  const unitsByMedicine = new Map<string, ProductUnit[]>();
  for (const unit of units) {
    const current = unitsByMedicine.get(unit.medicine_id) ?? [];
    current.push({
      id: unit.id,
      name: unit.name,
      conversion_factor: unit.conversion_factor,
      is_default_sale_unit: unit.is_default_sale_unit,
      price_paisa: unit.price_paisa,
      barcode: unit.barcode,
    });
    unitsByMedicine.set(unit.medicine_id, current);
  }
  const stockMap = stockByMedicine(batches);
  return all.map((medicine) => toProduct(
    medicine,
    unitsByMedicine.get(medicine.id) ?? [],
    stockMap.get(medicine.id) ?? { quantity: 0, expiry: null },
  ));
}

export async function loadProductDuplicateIdentities(): Promise<Array<{
  code: string;
  barcode: string | null;
  brand_name: string;
  generic_name: string;
  company: string;
  strength: string | null;
}>> {
  const rows = await fetchAllMedicines({
    page: 1,
    pageSize: 200,
    search: '',
    active: 'all',
    lowStockOnly: false,
    sort: 'name',
    order: 'asc',
  });
  return rows.map((medicine) => ({
    code: medicine.code,
    barcode: medicine.barcode ?? null,
    brand_name: medicine.name,
    generic_name: medicine.genericName ?? '',
    company: medicine.brandName ?? '',
    strength: medicine.strength ?? null,
  }));
}

export async function saveProduct(input: ProductInput): Promise<void> {
  const medicineBody = {
    code: input.code,
    name: input.name,
    genericName: input.genericName,
    ...(input.strength ? { strength: input.strength } : {}),
    categoryId: input.categoryId,
    brandId: input.brandId,
    drugClass: input.drugClass,
    storageCondition: input.storageCondition,
    rackLocation: input.rackLocation,
    minStockAlert: input.minStockAlert,
    requiresPrescription: input.requiresPrescription,
    isActive: input.isActive,
    barcode: input.barcode,
  };
  const apiUnits = input.units.map((unit) => ({
    name: unit.name,
    conversionFactorBaseUnits: unit.conversionFactorBaseUnits,
    pricePaisa: String(unit.pricePaisa),
    isDefaultSaleUnit: unit.isDefaultSaleUnit,
    barcode: unit.barcode,
  }));

  if (!input.id) {
    const response = await apiRequest<unknown>('/api/medicines', {
      method: 'POST',
      body: JSON.stringify({ ...medicineBody, units: apiUnits }),
    });
    if (!isRecord(response) || typeof response.id !== 'string') {
      throw new Error('The product service returned an invalid response.');
    }
    return;
  }

  const response = await apiRequest<unknown>(`/api/medicines/${encodeURIComponent(input.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(medicineBody),
  });
  parseMedicine(response);
  const unitsInSafeOrder = input.units
    .map((unit, index) => ({ unit, index }))
    .sort((left, right) => Number(right.unit.isDefaultSaleUnit) - Number(left.unit.isDefaultSaleUnit));
  for (const { unit, index } of unitsInSafeOrder) {
    const body = apiUnits[index];
    if (!body) continue;
    if (unit.id) {
      await apiRequest<unknown>(`/api/medicine-units/${encodeURIComponent(unit.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
    } else {
      await apiRequest<unknown>(`/api/medicines/${encodeURIComponent(input.id)}/units`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }
  }
  const retained = new Set(input.units.flatMap((unit) => unit.id ? [unit.id] : []));
  for (const unitId of input.existingUnitIds) {
    if (!retained.has(unitId)) {
      await apiRequest<null>(`/api/medicine-units/${encodeURIComponent(unitId)}`, { method: 'DELETE' });
    }
  }
}

export async function updateProductFields(id: string, updates: Record<string, unknown>): Promise<void> {
  await apiRequest<unknown>(`/api/medicines/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function assignProductBarcode(id: string): Promise<string> {
  const response = await apiRequest<unknown>(`/api/medicines/${encodeURIComponent(id)}/barcode`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!isRecord(response) || typeof response.barcode !== 'string' || !/^\d{8,14}$/.test(response.barcode)) {
    throw new Error('The product service returned an invalid barcode response.');
  }
  return response.barcode;
}

export async function assignMissingProductBarcodes(limit = 2000): Promise<{ assigned: number; skipped: number; failed: number }> {
  const response = await apiRequest<unknown>('/api/medicines/barcodes/assign-missing', {
    method: 'POST',
    body: JSON.stringify({ limit }),
  });
  if (!isRecord(response) || !Array.isArray(response.assigned) || !Array.isArray(response.errors)
    || !safeCount(response.total)) {
    throw new Error('The product service returned an invalid barcode response.');
  }
  return {
    assigned: response.assigned.length,
    skipped: Math.max(0, response.total - response.assigned.length - response.errors.length),
    failed: response.errors.length,
  };
}

export async function importProductRows(rows: readonly Record<string, string>[]): Promise<{
  importedCount: number;
  rowErrors: Array<{ line: number; code: string }>;
}> {
  const headers = [
    'code', 'name', 'genericName', 'strength', 'category', 'manufacturer', 'drugClass',
    'storageCondition', 'rackLocation', 'minStockAlert', 'requiresPrescription', 'isActive',
    'unitName', 'conversionFactorBaseUnits', 'pricePaisa', 'barcode', 'unitBarcode',
  ];
  const csvValue = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const mappedRows = rows.map((row) => [
    row.code ?? '',
    row.brand_name ?? '',
    row.generic_name ?? '',
    row.strength ?? '',
    row.category ?? '',
    row.company ?? '',
    row.drug_class || 'OTC',
    row.storage_condition || 'ROOM_TEMPERATURE',
    row.rack_location ?? '',
    row.min_stock_alert || '0',
    row.requires_prescription || 'false',
    row.is_active || 'true',
    row.unit_name ?? '',
    row.conversion_factor ?? '',
    row.price_paisa ?? '',
    row.barcode ?? '',
    row.unit_barcode ?? '',
  ]);
  const response = await apiRequest<unknown>('/api/products/import', {
    method: 'POST',
    body: JSON.stringify({ csv: [headers, ...mappedRows].map((row) => row.map(csvValue).join(',')).join('\r\n') }),
  });
  if (!isRecord(response) || !safeCount(response.importedCount) || !Array.isArray(response.rowErrors)) {
    throw new Error('The product service returned an invalid import response.');
  }
  const rowErrors = response.rowErrors.map((item) => {
    if (!isRecord(item) || !safeCount(item.line) || typeof item.code !== 'string') {
      throw new Error('The product service returned an invalid import response.');
    }
    return { line: item.line, code: item.code };
  });
  return { importedCount: response.importedCount, rowErrors };
}
