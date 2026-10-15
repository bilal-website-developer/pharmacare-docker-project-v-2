import { apiRequest, getBackend } from '../api';
import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { supabase } from '../utils/supabase';
import { isPosCatalogResponse, toPosCatalogProducts } from './posCatalogLogic';
import type { PosCatalogProduct } from './posCatalogLogic';

interface ApiCatalogUnit {
  id: string;
  name: string;
  conversionFactorBaseUnits: number;
  pricePaisa: string;
  isDefaultSaleUnit: boolean;
  barcode: string | null;
}

interface ApiCatalogBatch {
  id: string;
  batchNumber: string;
  expiryDate: string;
  receivedDate: string;
  quantityBaseUnits: string;
  status: string;
}

interface ApiCatalogProduct {
  id: string;
  code: string;
  barcode: string | null;
  name: string;
  genericName: string;
  strength: string | null;
  category: string;
  company: string;
  drugClass: string;
  requiresPrescription: boolean;
  stockBaseUnits: string;
  units: ApiCatalogUnit[];
  batches: ApiCatalogBatch[];
}

const PRODUCT_KEYS = [
  'id', 'code', 'barcode', 'name', 'genericName', 'strength', 'category', 'company',
  'drugClass', 'requiresPrescription', 'stockBaseUnits', 'units', 'batches',
];
const UNIT_KEYS = [
  'id', 'name', 'conversionFactorBaseUnits', 'pricePaisa', 'isDefaultSaleUnit', 'barcode',
];
const BATCH_KEYS = [
  'id', 'batchNumber', 'expiryDate', 'receivedDate', 'quantityBaseUnits', 'status',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function isSafeIntegerString(value: unknown): value is string {
  return isIntegerString(value) && Number.isSafeInteger(Number(value));
}

function isApiUnit(value: unknown): value is ApiCatalogUnit {
  return isRecord(value)
    && hasExactKeys(value, UNIT_KEYS)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && Number.isSafeInteger(value.conversionFactorBaseUnits)
    && Number(value.conversionFactorBaseUnits) > 0
    && isSafeIntegerString(value.pricePaisa)
    && typeof value.isDefaultSaleUnit === 'boolean'
    && (typeof value.barcode === 'string' || value.barcode === null);
}

function isDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isApiBatch(value: unknown): value is ApiCatalogBatch {
  return isRecord(value)
    && hasExactKeys(value, BATCH_KEYS)
    && typeof value.id === 'string'
    && typeof value.batchNumber === 'string'
    && isDateOnly(value.expiryDate)
    && isDateOnly(value.receivedDate)
    && isSafeIntegerString(value.quantityBaseUnits)
    && Number(value.quantityBaseUnits) > 0
    && (value.status === 'ACTIVE' || value.status === 'NEAR_EXPIRY');
}

function isApiProduct(value: unknown): value is ApiCatalogProduct {
  return isRecord(value)
    && hasExactKeys(value, PRODUCT_KEYS)
    && typeof value.id === 'string'
    && typeof value.code === 'string'
    && (typeof value.barcode === 'string' || value.barcode === null)
    && typeof value.name === 'string'
    && typeof value.genericName === 'string'
    && (typeof value.strength === 'string' || value.strength === null)
    && typeof value.category === 'string'
    && typeof value.company === 'string'
    && typeof value.drugClass === 'string'
    && typeof value.requiresPrescription === 'boolean'
    && isIntegerString(value.stockBaseUnits)
    && Array.isArray(value.units)
    && value.units.length > 0
    && value.units.every(isApiUnit)
    && Array.isArray(value.batches)
    && value.batches.length > 0
    && value.batches.every(isApiBatch);
}

function parseApiCatalog(value: unknown): { today: string; items: ApiCatalogProduct[] } {
  if (!isRecord(value)
    || !hasExactKeys(value, ['today', 'items'])
    || !isDateOnly(value.today)
    || !Array.isArray(value.items)) {
    throw new Error('The POS catalog service returned an invalid response.');
  }
  const items = value.items.filter(isApiProduct);
  if (items.length !== value.items.length) {
    throw new Error('The POS catalog service returned an invalid response.');
  }
  return { today: value.today, items };
}

function safeNumber(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('The POS catalog contains an integer outside the supported UI range.');
  }
  return number;
}

function toLegacyCatalogShape(items: readonly ApiCatalogProduct[]): unknown[] {
  return items.map((product) => ({
    id: product.id,
    code: product.code,
    barcode: product.barcode,
    brandName: product.name,
    genericName: product.genericName,
    strength: product.strength,
    category: product.category,
    company: product.company,
    drugClass: product.drugClass,
    units: product.units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      conversionFactor: unit.conversionFactorBaseUnits,
      isDefaultSaleUnit: unit.isDefaultSaleUnit,
      pricePerUnitPaisa: safeNumber(unit.pricePaisa),
    })),
    batches: product.batches.map((batch) => ({
      id: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      receivedDate: batch.receivedDate,
      quantitySmallestUnit: safeNumber(batch.quantityBaseUnits),
      status: batch.status,
    })),
  }));
}

export async function loadPosCatalog(): Promise<PosCatalogProduct[]> {
  if (getBackend() === 'api') {
    const payload = await apiRequest<unknown>('/api/pos/catalog');
    const catalog = parseApiCatalog(payload);
    const mapped = toLegacyCatalogShape(catalog.items);
    if (!isPosCatalogResponse(mapped)) {
      throw new Error('The POS catalog service returned an invalid response.');
    }
    return toPosCatalogProducts(mapped, catalog.today);
  }

  if (!supabase) {
    throw new Error(getSupabaseErrorMessage(
      new Error('Supabase is not configured.'),
      'Could not load the POS catalog.',
    ));
  }

  const { data, error } = await supabase.rpc('pos_catalog');
  if (error) {
    throw new Error(getSupabaseErrorMessage(error, 'Could not load the POS catalog.'));
  }
  if (!isPosCatalogResponse(data)) {
    throw new Error(getSupabaseErrorMessage(
      new Error('The POS catalog service returned an invalid response.'),
      'Could not load the POS catalog.',
    ));
  }

  return toPosCatalogProducts(data);
}
