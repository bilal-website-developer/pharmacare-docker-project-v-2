import { Decimal128, Long, ObjectId } from 'mongodb';
import { z } from 'zod';

export const STOCK_STATUSES = [
  'ACTIVE',
  'NEAR_EXPIRY',
  'EXPIRED',
  'QUARANTINE',
  'DAMAGED',
  'RETURNED',
  'RECALLED',
  'SOLD_OUT',
] as const;

export const MOVEMENT_TYPES = [
  'RECEIPT',
  'SALE',
  'SALE_RETURN',
  'ADJUSTMENT',
  'WRITE_OFF',
  'PURCHASE_RETURN',
] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];
export type MovementType = (typeof MOVEMENT_TYPES)[number];

const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
const maxLong = 9_223_372_036_854_775_807n;
const nonnegativePaisa = z.string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= maxLong);
const positiveQuantity = z.number().int().min(1).max(2_147_483_647);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

export const postPurchaseSchema = z.object({
  supplierId: idSchema,
  invoiceNumber: z.string().trim().max(120).optional().default(''),
  purchaseDate: dateSchema.optional(),
  paymentType: z.enum(['cash', 'credit']),
  discountPaisa: nonnegativePaisa,
  notes: z.string().trim().max(2000).optional().default(''),
  items: z.array(z.object({
    medicineId: idSchema,
    unitId: idSchema,
    batchNumber: z.string().trim().min(1).max(100),
    expiryDate: dateSchema,
    quantity: positiveQuantity,
    bonusQuantity: z.number().int().min(0).max(2_147_483_647).default(0),
    unitCostPaisa: nonnegativePaisa,
    mrpPaisa: nonnegativePaisa,
  }).strict()).min(1).max(200),
}).strict();

export const purchaseHistoryQuerySchema = z.object({
  search: z.string().trim().max(160).optional(),
  paymentType: z.enum(['cash', 'credit']).optional(),
  status: z.enum(['posted', 'void']).optional(),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict().refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo);

export const purchaseIdSchema = idSchema;

export const stockBatchQuerySchema = z.object({
  tab: z.enum(['all', 'near-expiry', 'expired', 'low-stock']).default('all'),
  search: z.string().trim().max(160).optional(),
  sort: z.enum([
    'medicine_asc', 'medicine_desc', 'batch_asc', 'batch_desc',
    'expiry_asc', 'expiry_desc', 'quantity_asc', 'quantity_desc',
    'cost_asc', 'cost_desc', 'value_asc', 'value_desc',
  ]).default('expiry_asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  medicineId: idSchema.optional(),
  expiryBucket: z.enum(['expired', '0-30', '31-60', '61-90', '90+']).optional(),
}).strict();

export const stockAdjustmentQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
  reason: z.string().trim().max(200).optional(),
  batchId: idSchema.optional(),
}).strict().refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo);

const signedLongText = z.string()
  .regex(/^-?(0|[1-9]\d{0,18})$/)
  .refine((value) => {
    const amount = BigInt(value);
    return amount >= -maxLong && amount <= maxLong && amount !== 0n;
  });

export const adjustStockSchema = z.object({
  deltaBaseUnits: signedLongText,
  reason: z.string().trim().min(1).max(500),
}).strict();

export const writeOffSchema = z.object({
  reason: z.literal('expired'),
}).strict();

export type PostPurchaseInput = z.infer<typeof postPurchaseSchema>;
export type PurchaseHistoryQuery = z.infer<typeof purchaseHistoryQuerySchema>;
export type StockBatchQuery = z.infer<typeof stockBatchQuerySchema>;
export type StockAdjustmentQuery = z.infer<typeof stockAdjustmentQuerySchema>;

export interface PurchaseItemRecord {
  purchaseItemId: ObjectId;
  medicineId: ObjectId;
  medicineNameSnapshot: string;
  medicineCodeSnapshot: string;
  unitId: ObjectId;
  unitNameSnapshot: string;
  conversionFactorBaseUnits: number;
  quantityInUnits: number;
  bonusQuantityBaseUnits: Long;
  quantityReceivedBaseUnits: Long;
  unitCostPaisa: Long;
  mrpPaisa: Long;
  lineTotalPaisa: Long;
  batchId: ObjectId;
  batchNumber: string;
  expiryDate: Date;
}

export interface PurchaseRecord {
  _id: ObjectId;
  shopId: ObjectId;
  purchaseNumber: string;
  supplierId: ObjectId;
  supplierNameSnapshot: string;
  invoiceNumber: string;
  purchaseDate: Date;
  status: 'posted' | 'void';
  paymentType: 'cash' | 'credit';
  subtotalPaisa: Long;
  discountPaisa: Long;
  totalPaisa: Long;
  paidPaisa: Long;
  notes: string;
  items: PurchaseItemRecord[];
  createdBy: ObjectId;
  createdAt: Date;
  voidedAt?: Date;
  voidedBy?: ObjectId;
  voidReason?: string;
}

export interface StockBatchRecord {
  _id: ObjectId;
  shopId: ObjectId;
  medicineId: ObjectId;
  supplierId: ObjectId;
  purchaseId: ObjectId;
  purchaseItemId: ObjectId;
  batchNumber: string;
  expiryDate: Date;
  receivedDate: Date;
  quantityReceivedBaseUnits: Long;
  quantityReturnedBaseUnits: Long;
  quantityRemainingBaseUnits: Long;
  unitCostPaisaPerBaseUnit: Long;
  mrpPaisaPerBaseUnit: Long;
  status: StockStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface StockMovementRecord {
  _id: ObjectId;
  shopId: ObjectId;
  batchId: ObjectId;
  medicineId: ObjectId;
  movementType: MovementType;
  quantityDeltaBaseUnits: Long;
  referenceType: string;
  referenceId: ObjectId;
  reason: string;
  actorId: ObjectId;
  createdAt: Date;
}

export interface StockListRow extends StockBatchRecord {
  medicineName: string;
  genericName: string;
  medicineCode: string;
  barcode: string;
  medicineIsActive: boolean;
  minStockAlert: number;
  supplierName: string;
  sellableStockBaseUnits: Long | Decimal128;
  isSellable: boolean;
}

export interface StockMovementRow extends StockMovementRecord {
  batchNumber: string;
  medicineName: string;
  genericName: string;
  actorName: string;
}

export function objectId(value: string): ObjectId {
  return new ObjectId(value);
}

export function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function utcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addUtcDays(date: Date, days: number): Date {
  const result = utcDate(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function derivedExpiryStatus(expiryDate: Date, quantity: Long, today = utcDate(new Date())): StockStatus {
  if (quantity.lessThanOrEqual(Long.ZERO)) return 'SOLD_OUT';
  if (utcDate(expiryDate) < today) return 'EXPIRED';
  return utcDate(expiryDate) <= addUtcDays(today, 90) ? 'NEAR_EXPIRY' : 'ACTIVE';
}

export function longFromBigInt(value: bigint): Long {
  if (value < -maxLong || value > maxLong) throw new RangeError('Value exceeds signed Int64 range');
  return Long.fromString(value.toString());
}

export function longString(value: Long | undefined | null): string | null {
  return value === undefined || value === null ? null : value.toString();
}

export function roundDividePositive(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError('Expected nonnegative numerator and positive denominator');
  return (numerator + denominator / 2n) / denominator;
}
