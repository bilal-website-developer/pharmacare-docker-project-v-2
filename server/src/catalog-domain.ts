import { ObjectId } from 'mongodb';
import { z } from 'zod';

export const CATALOG_COLLECTIONS = [
  'categories',
  'brands',
  'medicines',
  'medicineUnits',
  'suppliers',
] as const;

export type CatalogCollection = (typeof CATALOG_COLLECTIONS)[number];
export type CatalogEntityType = 'category' | 'brand' | 'medicine' | 'medicine_unit' | 'supplier';

const trimmedName = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().default('');
const idText = z.string().regex(/^[a-f\d]{24}$/i);
const paisaText = z.string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);

export const namedRecordSchema = z.object({
  name: trimmedName(160),
  isActive: z.boolean().optional().default(true),
}).strict();

export const supplierSchema = z.object({
  name: trimmedName(200),
  contact: optionalText(500),
  address: optionalText(2000),
  licenceOrTaxNumber: optionalText(500),
  paymentTerms: z.string().trim().min(1).max(100),
  isActive: z.boolean().optional().default(true),
}).strict();

export const medicineInputSchema = z.object({
  code: trimmedName(64),
  name: trimmedName(200),
  genericName: trimmedName(200),
  strength: optionalText(120),
  categoryId: idText,
  brandId: idText,
  drugClass: z.enum(['OTC', 'RX', 'CONTROLLED', 'NARCOTIC']),
  storageCondition: z.enum(['ROOM_TEMPERATURE', 'COOL', 'COLD_REFRIGERATED']).default('ROOM_TEMPERATURE'),
  rackLocation: optionalText(120),
  minStockAlert: z.number().int().min(0).max(2_147_483_647).default(0),
  requiresPrescription: z.boolean().default(false),
  isActive: z.boolean().default(true),
  barcode: z.string().regex(/^\d{8,14}$/).nullable().optional(),
}).strict();

export const medicineUpdateSchema = medicineInputSchema.partial().extend({
  categoryId: idText.optional(),
  brandId: idText.optional(),
}).strict();

export const medicineUnitInputSchema = z.object({
  name: trimmedName(120),
  conversionFactorBaseUnits: z.number().int().min(1).max(2_147_483_647),
  pricePaisa: paisaText,
  isDefaultSaleUnit: z.boolean(),
  barcode: z.string().regex(/^\d{8,14}$/).nullable().optional(),
}).strict();

export const medicineUnitUpdateSchema = medicineUnitInputSchema.partial().strict();

export const listQuerySchema = z.object({
  search: z.string().trim().max(160).optional(),
  active: z.enum(['true', 'false', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().trim().max(32).optional(),
  order: z.enum(['asc', 'desc']).default('asc'),
  categoryId: idText.optional(),
  brandId: idText.optional(),
  drugClass: z.enum(['OTC', 'RX', 'CONTROLLED', 'NARCOTIC']).optional(),
}).strict();

export const trashQuerySchema = z.object({
  entityType: z.enum(['category', 'brand', 'medicine', 'medicine_unit', 'supplier']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const csvImportSchema = z.object({
  csv: z.string().min(1).max(5 * 1024 * 1024),
}).strict();

export const barcodeAssignSchema = z.object({
  unitId: idText.optional(),
}).strict();

export const bulkBarcodeSchema = z.object({
  limit: z.number().int().min(1).max(2000).default(2000),
}).strict();

export const csvMedicineRowSchema = z.object({
  code: trimmedName(64),
  name: trimmedName(200),
  genericName: trimmedName(200),
  strength: optionalText(120),
  category: trimmedName(160),
  manufacturer: trimmedName(160),
  drugClass: z.enum(['OTC', 'RX', 'CONTROLLED', 'NARCOTIC']),
  storageCondition: z.enum(['ROOM_TEMPERATURE', 'COOL', 'COLD_REFRIGERATED']).default('ROOM_TEMPERATURE'),
  rackLocation: optionalText(120),
  minStockAlert: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
  requiresPrescription: z.preprocess((value) => value === 'true', z.boolean()).default(false),
  isActive: z.preprocess((value) => value !== 'false', z.boolean()).default(true),
  unitName: trimmedName(120),
  conversionFactorBaseUnits: z.coerce.number().int().min(1).max(2_147_483_647),
  pricePaisa: paisaText,
  barcode: z.union([z.literal(''), z.string().regex(/^\d{8,14}$/)]).default(''),
  unitBarcode: z.union([z.literal(''), z.string().regex(/^\d{8,14}$/)]).default(''),
}).strict();

export type CatalogRecord = Record<string, unknown> & {
  _id: ObjectId;
  shopId: ObjectId;
  medicineId?: ObjectId;
  normalizedName?: string;
  normalizedCode?: string;
  barcode?: string;
  isActive?: boolean;
  isDefaultSaleUnit?: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
};

export function normalizeName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export function isEan13(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  return ean13CheckDigit(value.slice(0, 12)) === value[12];
}

export function ean13CheckDigit(firstTwelveDigits: string): string {
  if (!/^\d{12}$/.test(firstTwelveDigits)) {
    throw new Error('EAN-13 requires exactly 12 digits before the check digit');
  }
  const sum = [...firstTwelveDigits].reduce((total, digit, index) =>
    total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

export function generateInternalEan13(randomTwelveDigits: string): string {
  if (!/^\d{12}$/.test(randomTwelveDigits)) {
    throw new Error('Internal barcode seed must contain exactly 12 digits');
  }
  return `${randomTwelveDigits}${ean13CheckDigit(randomTwelveDigits)}`;
}

export function canViewCost(role: string, permissions: readonly string[]): boolean {
  if (role === 'admin') return true;
  if (role === 'manager') {
    return permissions.some((permission) =>
      ['products', 'stock_inventory', 'purchases', 'purchase_history'].includes(permission),
    );
  }
  if (role === 'accountant') {
    return permissions.some((permission) => ['purchase_history', 'reports'].includes(permission));
  }
  return false;
}

export function escapeCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function parseCsv(text: string): { headers: string[]; rows: Array<{ line: number; values: string[] }> } {
  const rows: Array<{ line: number; values: string[] }> = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
        if (character === '\n') line += 1;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      fields.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      fields.push(field);
      if (fields.some((value) => value.length > 0)) rows.push({ line: rowLine, values: fields });
      fields = [];
      field = '';
      line += 1;
      rowLine = line;
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('MALFORMED_CSV');
  fields.push(field);
  if (fields.some((value) => value.length > 0)) rows.push({ line: rowLine, values: fields });
  if (rows.length === 0) throw new Error('EMPTY_CSV');
  const [headerRow, ...dataRows] = rows;
  return {
    headers: headerRow!.values.map((value) => value.trim()),
    rows: dataRows,
  };
}

export const CSV_HEADERS = [
  'code',
  'name',
  'genericName',
  'strength',
  'category',
  'manufacturer',
  'drugClass',
  'storageCondition',
  'rackLocation',
  'minStockAlert',
  'requiresPrescription',
  'isActive',
  'unitName',
  'conversionFactorBaseUnits',
  'pricePaisa',
  'barcode',
  'unitBarcode',
] as const;
