export enum UserRole {
  ADMIN = 'admin',
  SUPER_ADMIN = 'super_admin',
  MANAGER = 'manager',
  CASHIER = 'cashier',
  ACCOUNTANT = 'accountant',
}

export const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.ADMIN]: 'Admin',
  [UserRole.SUPER_ADMIN]: 'Super Admin',
  [UserRole.MANAGER]: 'Manager',
  [UserRole.CASHIER]: 'Cashier',
  [UserRole.ACCOUNTANT]: 'Accountant',
};

export const ROLE_MAX_DISCOUNT: Record<UserRole, number> = {
  [UserRole.ADMIN]: 30,
  [UserRole.SUPER_ADMIN]: 30,
  [UserRole.MANAGER]: 15,
  [UserRole.CASHIER]: 10,
  [UserRole.ACCOUNTANT]: 0,
};

export const MAX_DISCOUNT_PAISA = 20000;

export enum DrugClass {
  OTC = 'OTC',
  RX = 'RX',
  CONTROLLED = 'CONTROLLED',
  NARCOTIC = 'NARCOTIC',
}

export enum BatchStatus {
  ACTIVE = 'ACTIVE',
  NEAR_EXPIRY = 'NEAR_EXPIRY',
  EXPIRED = 'EXPIRED',
  QUARANTINE = 'QUARANTINE',
  DAMAGED = 'DAMAGED',
  RETURNED = 'RETURNED',
}

export enum PaymentMethod {
  CASH = 'CASH',
  CARD = 'CARD',
  EASYPAISA = 'EASYPAISA',
  JAZZCASH = 'JAZZCASH',
  CREDIT = 'CREDIT',
  SPLIT = 'SPLIT',
}

export interface ProductUnit {
  id: string;
  name: string; // e.g. "Pack", "Strip", "Tablet"
  conversionFactor: number; // how many base units (tablets)
  isDefaultSaleUnit: boolean;
  pricePerUnitPaisa: number;
}

export interface Batch {
  id: string;
  productId: string;
  batchNumber: string;
  expiryDate: string; // ISO string
  receivedDate: string; // ISO date used for FIFO tie-breaking
  costPricePaisa: number;
  mrpPaisa: number;
  quantitySmallestUnit: number; // total tablets
  status: BatchStatus;
  supplierName: string;
}

export interface BatchAllocation {
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  quantitySmallestUnit: number;
}

export interface Product {
  id: string;
  code: string;
  barcode: string;
  brandName: string;
  genericName: string;
  category: string;
  company: string;
  drugClass: DrugClass;
  storageCondition: 'ROOM_TEMPERATURE' | 'COOL' | 'COLD_REFRIGERATED';
  rackLocation: string;
  units: ProductUnit[];
  batches: Batch[];
  minStockAlert: number;
  requiresPrescription: boolean;
}

export interface CartItem {
  productId: string;
  productName: string;
  genericName: string;
  batchId: string;
  batchNumber: string;
  expiryDate: string;
  drugClass: DrugClass;
  unitId?: string;
  unitName: string;
  conversionFactor: number;
  quantityInUnit: number;
  mrpPaisaPerUnit: number;
  costPaisaPerUnit: number | null;
  discountPercent: number;
  lineTotalPaisa: number;
  batchAllocations?: BatchAllocation[];
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  cnic?: string;
  creditLimitPaisa: number;
  currentBalancePaisa: number; // positive = customer owes money
  storeCreditPaisa?: number;
  address?: string;
}

export interface LedgerEntry {
  id: string;
  customerId: string;
  date: string;
  type: 'INVOICE' | 'PAYMENT' | 'RETURN';
  referenceNo: string;
  description: string;
  debitPaisa: number; // amount owed
  creditPaisa: number; // amount paid
  runningBalancePaisa: number;
}

export interface ControlledDrugLog {
  id: string;
  date: string;
  productName: string;
  genericName: string;
  batchNumber: string;
  drugClass: DrugClass;
  movementType: 'DISPENSED' | 'RECEIVED';
  quantitySmallestUnits: number;
  balanceAfter: number;
  patientName: string;
  patientCnic: string;
  doctorName: string;
  doctorRegNo: string;
  prescriptionRef: string;
  invoiceNumber: string;
  dispensedBy: string;
}

export interface CashTransaction {
  id: string;
  time: string;
  type: 'SALE' | 'CREDIT_RECOVERY' | 'EXPENSE' | 'OPENING_FLOAT' | 'RETURN' | 'SALE_VOID' | 'ADJUSTMENT';
  description: string;
  amountPaisa: number;
  isOutflow: boolean;
  handledBy: string;
}

export interface CompletedSale {
  id: string;
  invoiceNumber: string;
  timestamp: string;
  cashierName: string;
  status?: 'COMPLETED' | 'VOID';
  customerName?: string;
  customerPhone?: string;
  customerId?: string;
  items: CartItem[];
  subtotalPaisa: number;
  discountPaisa: number;
  totalPaisa: number;
  roundingPaisa?: number;
  paymentMethod: PaymentMethod;
  amountTenderedPaisa: number;
  changePaisa: number;
}
