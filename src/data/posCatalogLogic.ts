import { BatchStatus, DrugClass } from '../types/pharmacy';
import type { FefoBatch } from '../utils/fefo';
import { localIsoDate } from '../utils/fefo';

export interface PosCatalogUnit {
  id: string;
  name: string;
  conversionFactor: number;
  isDefaultSaleUnit: boolean;
  pricePerUnitPaisa: number;
}

export interface PosCatalogBatch extends FefoBatch {
  productId: string;
}

export interface PosCatalogProduct {
  catalogToday?: string;
  requiresPrescription?: boolean;
  id: string;
  code: string;
  barcode: string | null;
  brandName: string;
  genericName: string;
  strength: string | null;
  category: string;
  company: string;
  drugClass: DrugClass;
  units: PosCatalogUnit[];
  batches: PosCatalogBatch[];
}

interface RawPosCatalogUnit {
  id: string;
  name: string;
  conversionFactor: number;
  isDefaultSaleUnit: boolean;
  pricePerUnitPaisa: number;
}

interface RawPosCatalogBatch {
  id: string;
  batchNumber: string;
  expiryDate: string;
  receivedDate: string;
  quantitySmallestUnit: number;
  status: BatchStatus.ACTIVE | BatchStatus.NEAR_EXPIRY;
}

interface RawPosCatalogProduct {
  id: string;
  code: string;
  barcode: string | null;
  brandName: string;
  genericName: string;
  strength: string | null;
  category: string;
  company: string;
  drugClass: DrugClass;
  units: RawPosCatalogUnit[];
  batches: RawPosCatalogBatch[];
}

const PRODUCT_KEYS = [
  'id',
  'code',
  'barcode',
  'brandName',
  'genericName',
  'strength',
  'category',
  'company',
  'drugClass',
  'units',
  'batches',
];
const UNIT_KEYS = ['id', 'name', 'conversionFactor', 'isDefaultSaleUnit', 'pricePerUnitPaisa'];
const BATCH_KEYS = [
  'id',
  'batchNumber',
  'expiryDate',
  'receivedDate',
  'quantitySmallestUnit',
  'status',
];
const DRUG_CLASSES = new Set<string>(Object.values(DrugClass));
const BATCH_STATUSES = new Set<string>([BatchStatus.ACTIVE, BatchStatus.NEAR_EXPIRY]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isUnit(value: unknown): value is RawPosCatalogUnit {
  return isRecord(value)
    && hasExactKeys(value, UNIT_KEYS)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name)
    && Number.isSafeInteger(value.conversionFactor)
    && Number(value.conversionFactor) > 0
    && typeof value.isDefaultSaleUnit === 'boolean'
    && Number.isSafeInteger(value.pricePerUnitPaisa)
    && Number(value.pricePerUnitPaisa) >= 0;
}

function isBatch(value: unknown): value is RawPosCatalogBatch {
  return isRecord(value)
    && hasExactKeys(value, BATCH_KEYS)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.batchNumber)
    && isDate(value.expiryDate)
    && isDate(value.receivedDate)
    && Number.isSafeInteger(value.quantitySmallestUnit)
    && Number(value.quantitySmallestUnit) > 0
    && typeof value.status === 'string'
    && BATCH_STATUSES.has(value.status);
}

function isProduct(value: unknown): value is RawPosCatalogProduct {
  return isRecord(value)
    && hasExactKeys(value, PRODUCT_KEYS)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.code)
    && (typeof value.barcode === 'string' || value.barcode === null)
    && isNonEmptyString(value.brandName)
    && typeof value.genericName === 'string'
    && (typeof value.strength === 'string' || value.strength === null)
    && typeof value.category === 'string'
    && typeof value.company === 'string'
    && typeof value.drugClass === 'string'
    && DRUG_CLASSES.has(value.drugClass)
    && Array.isArray(value.units)
    && value.units.length > 0
    && value.units.every(isUnit)
    && Array.isArray(value.batches)
    && value.batches.length > 0
    && value.batches.every(isBatch);
}

export function isPosCatalogResponse(value: unknown): value is RawPosCatalogProduct[] {
  return Array.isArray(value) && value.every(isProduct);
}

export function getRequiredSmallestUnits(quantity: number, conversionFactor: number): number {
  const requiredSmallestUnits = quantity * conversionFactor;
  if (
    !Number.isSafeInteger(quantity)
    || quantity <= 0
    || !Number.isSafeInteger(conversionFactor)
    || conversionFactor <= 0
    || !Number.isSafeInteger(requiredSmallestUnits)
  ) {
    throw new RangeError('Sale quantity must convert to a positive whole number of smallest units.');
  }
  return requiredSmallestUnits;
}

export function toPosCatalogProducts(
  rows: readonly RawPosCatalogProduct[],
  catalogToday = localIsoDate(),
): PosCatalogProduct[] {
  return rows.map((product) => ({
    ...product,
    catalogToday,
    batches: product.batches.map((batch) => ({
      ...batch,
      productId: product.id,
    })),
  }));
}
