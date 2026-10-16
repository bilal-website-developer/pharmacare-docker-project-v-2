import { apiRequest } from '../api';

export interface MasterDataValue {
  id: string;
  name: string;
  is_active: boolean;
  product_count: number;
  low_count: number;
  out_count: number;
  expiring_count: number;
  stock_value_paisa: number | null;
}

export interface MasterDataOverview {
  categories: MasterDataValue[];
  manufacturers: MasterDataValue[];
  summary: {
    category_count: number;
    active_category_count: number;
    manufacturer_count: number;
    active_manufacturer_count: number;
    product_count: number;
    unit_count: number;
  };
}

export interface MasterDataUnit {
  id: string;
  medicine_id: string;
  name: string;
  conversion_factor: number;
  is_default_sale_unit: boolean;
  price_paisa: number;
  barcode: string | null;
  medicine_name: string;
}

export type MasterDataKind = 'category' | 'brand';

const OVERVIEW_KEYS = ['categories', 'manufacturers', 'summary'] as const;
const VALUE_KEYS = [
  'id', 'name', 'is_active', 'product_count', 'low_count',
  'out_count', 'expiring_count', 'stock_value_paisa',
] as const;
const SUMMARY_KEYS = [
  'category_count', 'active_category_count', 'manufacturer_count',
  'active_manufacturer_count', 'product_count', 'unit_count',
] as const;
const UNIT_KEYS = [
  'id', 'medicine_id', 'name', 'conversion_factor', 'is_default_sale_unit',
  'price_paisa', 'barcode', 'medicine_name',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safePaisa(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('The master-data service returned an invalid response.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('The master-data service returned an invalid response.');
  return parsed;
}

function parseValue(value: unknown): MasterDataValue {
  if (!isRecord(value) || !hasExactKeys(value, VALUE_KEYS)
    || typeof value.id !== 'string' || !/^[a-f\d]{24}$/i.test(value.id)
    || typeof value.name !== 'string' || typeof value.is_active !== 'boolean'
    || !safeCount(value.product_count) || !safeCount(value.low_count)
    || !safeCount(value.out_count) || !safeCount(value.expiring_count)) {
    throw new Error('The master-data service returned an invalid response.');
  }
  return {
    id: value.id,
    name: value.name,
    is_active: value.is_active,
    product_count: value.product_count,
    low_count: value.low_count,
    out_count: value.out_count,
    expiring_count: value.expiring_count,
    stock_value_paisa: safePaisa(value.stock_value_paisa),
  };
}

function parseOverview(value: unknown): MasterDataOverview {
  if (!isRecord(value) || !hasExactKeys(value, OVERVIEW_KEYS)
    || !Array.isArray(value.categories) || !Array.isArray(value.manufacturers)
    || !isRecord(value.summary)) {
    throw new Error('The master-data service returned an invalid response.');
  }
  const summary = value.summary;
  if (!hasExactKeys(summary, SUMMARY_KEYS)
    || !safeCount(summary.category_count)
    || !safeCount(summary.active_category_count)
    || !safeCount(summary.manufacturer_count)
    || !safeCount(summary.active_manufacturer_count)
    || !safeCount(summary.product_count)
    || !safeCount(summary.unit_count)) {
    throw new Error('The master-data service returned an invalid response.');
  }
  return {
    categories: value.categories.map(parseValue),
    manufacturers: value.manufacturers.map(parseValue),
    summary: {
      category_count: summary.category_count,
      active_category_count: summary.active_category_count,
      manufacturer_count: summary.manufacturer_count,
      active_manufacturer_count: summary.active_manufacturer_count,
      product_count: summary.product_count,
      unit_count: summary.unit_count,
    },
  };
}

function parseUnit(value: unknown): MasterDataUnit {
  if (!isRecord(value) || !hasExactKeys(value, UNIT_KEYS)
    || typeof value.id !== 'string' || !/^[a-f\d]{24}$/i.test(value.id)
    || typeof value.medicine_id !== 'string' || !/^[a-f\d]{24}$/i.test(value.medicine_id)
    || typeof value.name !== 'string'
    || !safeCount(value.conversion_factor) || value.conversion_factor < 1
    || typeof value.is_default_sale_unit !== 'boolean'
    || typeof value.medicine_name !== 'string'
    || !(value.barcode === null || typeof value.barcode === 'string')) {
    throw new Error('The master-data service returned an invalid response.');
  }
  const price = safePaisa(value.price_paisa);
  if (price === null) throw new Error('The master-data service returned an invalid response.');
  return {
    id: value.id,
    medicine_id: value.medicine_id,
    name: value.name,
    conversion_factor: value.conversion_factor,
    is_default_sale_unit: value.is_default_sale_unit,
    price_paisa: price,
    barcode: value.barcode,
    medicine_name: value.medicine_name,
  };
}

function resourcePath(kind: MasterDataKind): string {
  return kind === 'category' ? 'categories' : 'brands';
}

export async function loadMasterDataOverview(): Promise<MasterDataOverview> {
  return parseOverview(await apiRequest<unknown>('/api/master-data/overview'));
}

export async function loadMasterDataUnits(): Promise<MasterDataUnit[]> {
  const response = await apiRequest<unknown>('/api/master-data/units');
  if (!isRecord(response) || !hasExactKeys(response, ['items']) || !Array.isArray(response.items)) {
    throw new Error('The master-data service returned an invalid response.');
  }
  return response.items.map(parseUnit);
}

export async function saveMasterDataName(
  kind: MasterDataKind,
  id: string | null,
  name: string,
  isActive: boolean,
): Promise<void> {
  const path = resourcePath(kind);
  const response = await apiRequest<unknown>(id
    ? `/api/${path}/${encodeURIComponent(id)}`
    : `/api/${path}`, {
    method: id ? 'PATCH' : 'POST',
    body: JSON.stringify({ name, isActive }),
  });
  if (!isRecord(response)
    || !hasExactKeys(response, ['id', 'name', 'isActive', 'createdAt', 'updatedAt'])
    || typeof response.id !== 'string' || typeof response.name !== 'string'
    || typeof response.isActive !== 'boolean'
    || typeof response.createdAt !== 'string' || typeof response.updatedAt !== 'string') {
    throw new Error('The master-data service returned an invalid response.');
  }
}

export async function deleteMasterDataName(kind: MasterDataKind, id: string): Promise<void> {
  await apiRequest<null>(`/api/${resourcePath(kind)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function mergeMasterDataNames(
  kind: MasterDataKind,
  sourceId: string,
  targetId: string,
): Promise<number> {
  const response = await apiRequest<unknown>(
    `/api/${resourcePath(kind)}/${encodeURIComponent(sourceId)}/merge`,
    { method: 'POST', body: JSON.stringify({ targetId }) },
  );
  if (!isRecord(response) || !hasExactKeys(response, ['productCount']) || !safeCount(response.productCount)) {
    throw new Error('The master-data service returned an invalid response.');
  }
  return response.productCount;
}
