import { ObjectId } from 'mongodb';
import { z } from 'zod';

const idText = z.string().regex(/^[a-f\d]{24}$/i);
const paisaText = z.string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

const prescriptionSchema = z.object({
  prescriber: z.string().trim().min(1).max(160),
  patient: z.string().trim().min(1).max(160),
  reference: z.string().trim().min(1).max(160),
}).strict();

export const postSaleSchema = z.object({
  customerId: idText.optional(),
  customerName: z.string().trim().max(200).optional().default(''),
  items: z.array(z.object({
    medicineId: idText,
    unitId: idText,
    quantityInUnit: z.number().int().min(1).max(100_000),
    prescription: prescriptionSchema.optional(),
  }).strict()).min(1).max(100),
  discountPaisa: paisaText,
  payments: z.array(z.object({
    method: z.enum(['CASH', 'CARD', 'CREDIT']),
    amountPaisa: paisaText,
  }).strict()).min(1).max(3),
  amountTenderedPaisa: paisaText,
}).strict().superRefine((sale, context) => {
  const methods = sale.payments.map((payment) => payment.method);
  if (new Set(methods).size !== methods.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['payments'], message: 'Duplicate payment method' });
  }
});

export const customerCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(80).optional().default(''),
  cnic: z.string().trim().max(80).nullable().optional(),
  address: z.string().trim().max(1000).optional().default(''),
  creditLimitPaisa: paisaText.optional().default('0'),
}).strict();

export const customerUpdateSchema = customerCreateSchema.partial().strict();

export const customerListQuerySchema = z.object({
  search: z.string().trim().max(160).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const customerPaymentSchema = z.object({
  amountPaisa: paisaText.refine((amount) => BigInt(amount) > 0n),
  method: z.enum(['CASH', 'CARD']).default('CASH'),
  note: z.string().trim().max(500).optional().default(''),
}).strict();

export const salesHistoryQuerySchema = z.object({
  search: z.string().trim().max(160).optional(),
  dateFrom: dateText.optional(),
  dateTo: dateText.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
}).strict().refine((query) => !query.dateFrom || !query.dateTo || query.dateFrom <= query.dateTo);

export type PostSaleInput = z.infer<typeof postSaleSchema>;
export type CustomerInput = z.infer<typeof customerCreateSchema>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;
export type CustomerPaymentInput = z.infer<typeof customerPaymentSchema>;
export type SalesHistoryQuery = z.infer<typeof salesHistoryQuerySchema>;

export interface CustomerRecord {
  _id: ObjectId;
  shopId: ObjectId;
  name: string;
  normalizedName: string;
  phone: string;
  cnic: string | null;
  address: string;
  creditLimitPaisa: import('mongodb').Long;
  currentBalancePaisa: import('mongodb').Long;
  storeCreditPaisa: import('mongodb').Long;
  createdBy?: ObjectId;
  updatedBy?: ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SalePaymentRecord {
  _id: ObjectId;
  shopId: ObjectId;
  saleId: ObjectId;
  method: 'CASH' | 'CARD' | 'CREDIT';
  amountPaisa: import('mongodb').Long;
  createdAt: Date;
}

export interface SaleItemRecord {
  _id: ObjectId;
  medicineId: ObjectId;
  medicineCode: string;
  medicineName: string;
  genericName: string;
  drugClass: string;
  unitId: ObjectId;
  unitName: string;
  conversionFactorBaseUnits: number;
  quantityInUnit: number;
  quantityBaseUnits: import('mongodb').Long;
  pricePaisaPerUnit: import('mongodb').Long;
  lineDiscountPaisa: import('mongodb').Long;
  lineTotalPaisa: import('mongodb').Long;
  prescription?: z.infer<typeof prescriptionSchema>;
  batchAllocations: Array<{
    batchId: ObjectId;
    batchNumber: string;
    expiryDate: Date;
    quantityBaseUnits: import('mongodb').Long;
  }>;
}

export interface SaleRecord {
  _id: ObjectId;
  shopId: ObjectId;
  invoiceNumber: string;
  cashierId: ObjectId;
  cashierName: string;
  customerId: ObjectId | null;
  customerName: string;
  customerPhone: string;
  soldAt: Date;
  subtotalPaisa: import('mongodb').Long;
  discountPaisa: import('mongodb').Long;
  totalPaisa: import('mongodb').Long;
  amountTenderedPaisa: import('mongodb').Long;
  changePaisa: import('mongodb').Long;
  paymentMethod: 'CASH' | 'CARD' | 'CREDIT' | 'SPLIT';
  status: 'COMPLETED';
  items: SaleItemRecord[];
}

export function timezoneToday(timeZone: string, now = new Date()): Date {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now).map((part) => [part.type, part.value]));
  } catch {
    throw new Error('INVALID_SHOP_TIMEZONE');
  }
  const dateText = `${parts.year}-${parts.month}-${parts.day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) throw new Error('INVALID_SHOP_TIMEZONE');
  return new Date(`${dateText}T00:00:00.000Z`);
}

export function normalizedCustomerName(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
