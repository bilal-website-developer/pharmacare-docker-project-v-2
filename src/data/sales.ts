import {
  DrugClass,
  PaymentMethod,
  type BatchAllocation,
  type CartItem,
  type CompletedSale,
  type Customer,
} from '../types/pharmacy';
import { apiRequest, getBackend } from '../api';
import { getSupabaseErrorMessage } from '../utils/supabaseError';
import { supabase } from '../utils/supabase';

export interface SalePaymentInput {
  paymentMethod: Exclude<PaymentMethod, PaymentMethod.SPLIT>;
  amountPaisa: number;
}

export interface PrescriptionDetails {
  prescriber: string;
  patient: string;
  reference: string;
}

export interface PostSaleInput {
  customerId: string | null;
  customerName: string;
  items: Array<{
    medicineId: string;
    unitId: string;
    quantityInUnit: number;
    prescription?: PrescriptionDetails;
  }>;
  discountPaisa: number;
  roundingPaisa: number;
  tenderedPaisa: number;
  payments: SalePaymentInput[];
}

export interface CustomerAccountsData {
  customers: Customer[];
  ledgerEntries: Record<string, Array<{
    id: string;
    customerId: string;
    date: string;
    type: 'INVOICE' | 'PAYMENT' | 'RETURN';
    referenceNo: string;
    description: string;
    debitPaisa: number;
    creditPaisa: number;
    runningBalancePaisa: number;
  }>>;
}

export interface CustomerPaymentResult {
  referenceNo: string;
  dateTime: string;
  balanceAfterPaisa: number;
  storeCreditPaisa: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function apiPaisaNumber(value: unknown, allowNegative = false): number | null {
  if (typeof value !== 'string'
    || !(allowNegative ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function parsePosCustomer(value: unknown): Customer | null {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'id', 'name', 'phone', 'address', 'creditLimitPaisa', 'currentBalancePaisa', 'storeCreditPaisa',
    ])
    || !isString(value.id) || !isString(value.name) || !isString(value.phone) || !isString(value.address)) {
    return null;
  }
  const creditLimitPaisa = apiPaisaNumber(value.creditLimitPaisa);
  const currentBalancePaisa = apiPaisaNumber(value.currentBalancePaisa);
  const storeCreditPaisa = apiPaisaNumber(value.storeCreditPaisa);
  if (creditLimitPaisa === null || currentBalancePaisa === null || storeCreditPaisa === null) return null;
  return { id: value.id, name: value.name, phone: value.phone, address: value.address, creditLimitPaisa, currentBalancePaisa, storeCreditPaisa };
}

function parseSalePrescription(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['prescriber', 'patient', 'reference'])
    && isString(value.prescriber) && isString(value.patient) && isString(value.reference);
}

function parseApiSale(value: unknown): CompletedSale {
  const saleKeys = [
    'id', 'invoiceNumber', 'timestamp', 'cashierName', 'customerId', 'customerName', 'customerPhone',
    'subtotalPaisa', 'discountPaisa', 'roundingPaisa', 'totalPaisa', 'amountTenderedPaisa',
    'changePaisa', 'paymentMethod', 'status', 'items',
  ];
  if (!isRecord(value) || !hasExactKeys(value, saleKeys)
    || !isString(value.id) || !isString(value.invoiceNumber) || !isString(value.timestamp)
    || !isString(value.cashierName) || (value.customerId !== null && !isString(value.customerId))
    || !isString(value.customerName) || !isString(value.customerPhone)
    || value.status !== 'COMPLETED' || !Array.isArray(value.items)) {
    throw new Error('The sales service returned an invalid response.');
  }
  const paymentMethod = value.paymentMethod === 'CASH' ? PaymentMethod.CASH
    : value.paymentMethod === 'CARD' ? PaymentMethod.EASYPAISA
      : value.paymentMethod === 'CREDIT' ? PaymentMethod.CREDIT
        : value.paymentMethod === 'SPLIT' ? PaymentMethod.SPLIT
          : null;
  const subtotalPaisa = apiPaisaNumber(value.subtotalPaisa);
  const discountPaisa = apiPaisaNumber(value.discountPaisa);
  const roundingPaisa = apiPaisaNumber(value.roundingPaisa, true);
  const totalPaisa = apiPaisaNumber(value.totalPaisa);
  const amountTenderedPaisa = apiPaisaNumber(value.amountTenderedPaisa);
  const changePaisa = apiPaisaNumber(value.changePaisa);
  if (!paymentMethod || subtotalPaisa === null || discountPaisa === null || roundingPaisa === null
    || totalPaisa === null || amountTenderedPaisa === null || changePaisa === null) {
    throw new Error('The sales service returned an invalid response.');
  }

  const items: CartItem[] = value.items.map((rawItem) => {
    if (!isRecord(rawItem)) throw new Error('The sales service returned an invalid response.');
    const itemKeys = [
      'id', 'medicineId', 'medicineCode', 'productName', 'genericName', 'drugClass', 'unitId', 'unitName',
      'conversionFactor', 'quantityInUnit', 'quantityBaseUnits', 'pricePaisaPerUnit', 'lineDiscountPaisa',
      'lineTotalPaisa', 'batchAllocations',
    ];
    const optionalPrescription = 'prescription' in rawItem;
    if (!hasExactKeys(rawItem, optionalPrescription ? [...itemKeys, 'prescription'] : itemKeys)
      || !isString(rawItem.id) || !isString(rawItem.medicineId) || !isString(rawItem.medicineCode)
      || !isString(rawItem.productName)
      || !isString(rawItem.genericName) || !isDrugClass(rawItem.drugClass)
      || !isString(rawItem.unitId) || !isString(rawItem.unitName)
      || !Number.isSafeInteger(rawItem.conversionFactor) || Number(rawItem.conversionFactor) <= 0
      || !isPositiveInteger(rawItem.quantityInUnit)
      || (optionalPrescription && !parseSalePrescription(rawItem.prescription))
      || !Array.isArray(rawItem.batchAllocations) || rawItem.batchAllocations.length === 0) {
      throw new Error('The sales service returned an invalid response.');
    }
    const quantitySmallestUnit = apiPaisaNumber(rawItem.quantityBaseUnits);
    const mrpPaisaPerUnit = apiPaisaNumber(rawItem.pricePaisaPerUnit);
    const lineDiscountPaisa = apiPaisaNumber(rawItem.lineDiscountPaisa);
    const lineTotalPaisa = apiPaisaNumber(rawItem.lineTotalPaisa);
    if (quantitySmallestUnit === null || quantitySmallestUnit <= 0
      || mrpPaisaPerUnit === null || lineDiscountPaisa === null || lineTotalPaisa === null) {
      throw new Error('The sales service returned an invalid response.');
    }
    const batchAllocations = rawItem.batchAllocations.map((rawAllocation) => {
      if (!isRecord(rawAllocation)
        || !hasExactKeys(rawAllocation, ['batchId', 'batchNumber', 'expiryDate', 'quantityBaseUnits'])
        || !isString(rawAllocation.batchId) || !isString(rawAllocation.batchNumber)
        || !isString(rawAllocation.expiryDate)) {
        throw new Error('The sales service returned an invalid response.');
      }
      const quantity = apiPaisaNumber(rawAllocation.quantityBaseUnits);
      if (quantity === null || quantity <= 0) throw new Error('The sales service returned an invalid response.');
      return {
        batchId: rawAllocation.batchId,
        batchNumber: rawAllocation.batchNumber,
        expiryDate: rawAllocation.expiryDate,
        quantitySmallestUnit: quantity,
      };
    });
    const firstAllocation = batchAllocations[0];
    if (!firstAllocation) throw new Error('The sales service returned an invalid response.');
    return {
      productId: rawItem.medicineId,
      productName: rawItem.productName,
      genericName: rawItem.genericName,
      batchId: firstAllocation.batchId,
      batchNumber: firstAllocation.batchNumber,
      expiryDate: firstAllocation.expiryDate,
      drugClass: rawItem.drugClass,
      unitId: rawItem.unitId,
      unitName: rawItem.unitName,
      conversionFactor: Number(rawItem.conversionFactor),
      quantityInUnit: rawItem.quantityInUnit,
      mrpPaisaPerUnit,
      costPaisaPerUnit: null,
      discountPercent: 0,
      lineTotalPaisa,
      batchAllocations,
    };
  });

  return {
    id: value.id,
    invoiceNumber: value.invoiceNumber,
    timestamp: value.timestamp,
    cashierName: value.cashierName,
    ...(value.customerId ? { customerId: value.customerId } : {}),
    customerName: value.customerName,
    customerPhone: value.customerPhone,
    items,
    subtotalPaisa,
    discountPaisa,
    totalPaisa,
    roundingPaisa,
    paymentMethod,
    amountTenderedPaisa,
    changePaisa,
  };
}

function isDrugClass(value: unknown): value is DrugClass {
  return Object.values(DrugClass).some((drugClass) => drugClass === value);
}

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return Object.values(PaymentMethod).some((paymentMethod) => paymentMethod === value);
}

function isCustomer(value: unknown): value is Customer {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && isString(value.phone)
    && isString(value.address)
    && isNonNegativeInteger(value.creditLimitPaisa)
    && isNonNegativeInteger(value.currentBalancePaisa)
    && isNonNegativeInteger(value.storeCreditPaisa);
}

function parseApiCustomer(value: unknown): Customer | null {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'id', 'name', 'phone', 'cnic', 'address', 'creditLimitPaisa',
      'currentBalancePaisa', 'storeCreditPaisa', 'createdAt', 'updatedAt',
    ])
    || !isString(value.id) || !isString(value.name) || !isString(value.phone)
    || !(value.cnic === null || isString(value.cnic))
    || !isString(value.address) || !isString(value.createdAt) || !isString(value.updatedAt)) {
    return null;
  }
  const creditLimitPaisa = apiPaisaNumber(value.creditLimitPaisa);
  const currentBalancePaisa = apiPaisaNumber(value.currentBalancePaisa);
  const storeCreditPaisa = apiPaisaNumber(value.storeCreditPaisa);
  if (creditLimitPaisa === null || currentBalancePaisa === null || storeCreditPaisa === null) return null;
  return {
    id: value.id,
    name: value.name,
    phone: value.phone,
    ...(value.cnic === null ? {} : { cnic: value.cnic }),
    address: value.address,
    creditLimitPaisa,
    currentBalancePaisa,
    storeCreditPaisa,
  };
}

function parseApiLedgerEntry(value: unknown): CustomerAccountsData['ledgerEntries'][string][number] | null {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'id', 'customerId', 'date', 'type', 'referenceNo', 'description',
      'debitPaisa', 'creditPaisa', 'runningBalancePaisa',
    ])
    || !isString(value.id) || !isString(value.customerId) || !isString(value.date)
    || !(value.type === 'INVOICE' || value.type === 'PAYMENT' || value.type === 'RETURN')
    || !isString(value.referenceNo) || !isString(value.description)) {
    return null;
  }
  const debitPaisa = apiPaisaNumber(value.debitPaisa);
  const creditPaisa = apiPaisaNumber(value.creditPaisa);
  const runningBalancePaisa = apiPaisaNumber(value.runningBalancePaisa, true);
  if (debitPaisa === null || creditPaisa === null || runningBalancePaisa === null) return null;
  return {
    id: value.id,
    customerId: value.customerId,
    date: value.date,
    type: value.type,
    referenceNo: value.referenceNo,
    description: value.description,
    debitPaisa,
    creditPaisa,
    runningBalancePaisa,
  };
}

function isLedgerEntry(value: unknown): value is CustomerAccountsData['ledgerEntries'][string][number] {
  return isRecord(value)
    && isString(value.id)
    && isString(value.customerId)
    && isString(value.date)
    && (value.type === 'INVOICE' || value.type === 'PAYMENT' || value.type === 'RETURN')
    && isString(value.referenceNo)
    && isString(value.description)
    && isNonNegativeInteger(value.debitPaisa)
    && isNonNegativeInteger(value.creditPaisa)
    && Number.isSafeInteger(value.runningBalancePaisa);
}

function isCustomerAccountsData(value: unknown): value is CustomerAccountsData {
  if (!isRecord(value) || !Array.isArray(value.customers) || !value.customers.every(isCustomer)
      || !isRecord(value.ledgerEntries)) return false;
  return Object.values(value.ledgerEntries).every((entries) =>
    Array.isArray(entries) && entries.every(isLedgerEntry));
}

function isBatchAllocation(value: unknown): value is BatchAllocation {
  return isRecord(value)
    && isString(value.batchId)
    && isString(value.batchNumber)
    && isString(value.expiryDate)
    && isPositiveInteger(value.quantitySmallestUnit);
}

function isCartItem(value: unknown): value is CartItem {
  return isRecord(value)
    && isString(value.productId)
    && isString(value.productName)
    && isString(value.genericName)
    && isString(value.batchId)
    && isString(value.batchNumber)
    && isString(value.expiryDate)
    && isDrugClass(value.drugClass)
    && (value.unitId === undefined || isString(value.unitId))
    && isString(value.unitName)
    && isPositiveInteger(value.conversionFactor)
    && isPositiveInteger(value.quantityInUnit)
    && isNonNegativeInteger(value.mrpPaisaPerUnit)
    && value.costPaisaPerUnit === null
    && isNonNegativeInteger(value.discountPercent)
    && isNonNegativeInteger(value.lineTotalPaisa)
    && Array.isArray(value.batchAllocations)
    && value.batchAllocations.every(isBatchAllocation);
}

function isCompletedSale(value: unknown): value is CompletedSale {
  return isRecord(value)
    && isString(value.id)
    && isString(value.invoiceNumber)
    && isString(value.timestamp)
    && isString(value.cashierName)
    && (value.customerId === null || isString(value.customerId))
    && isString(value.customerName)
    && isString(value.customerPhone)
    && Array.isArray(value.items)
    && value.items.every(isCartItem)
    && isNonNegativeInteger(value.subtotalPaisa)
    && isNonNegativeInteger(value.discountPaisa)
    && isNonNegativeInteger(value.totalPaisa)
    && (value.roundingPaisa === undefined || Number.isSafeInteger(value.roundingPaisa))
    && isPaymentMethod(value.paymentMethod)
    && isNonNegativeInteger(value.amountTenderedPaisa)
    && isNonNegativeInteger(value.changePaisa);
}

function parseSaleHistory(value: unknown): CompletedSale | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const items = value.items.map((item): CartItem | null => {
    if (!isRecord(item) || !Array.isArray(item.batchAllocations)) return null;
    const batchAllocations: BatchAllocation[] = [];
    for (const allocation of item.batchAllocations) {
      if (!isRecord(allocation)
          || !isString(allocation.batchId)
          || !isString(allocation.batchNumber)
          || !isString(allocation.expiryDate)
          || !isPositiveInteger(allocation.quantityBaseUnits)) return null;
      batchAllocations.push({
        batchId: allocation.batchId,
        batchNumber: allocation.batchNumber,
        expiryDate: allocation.expiryDate,
        quantitySmallestUnit: allocation.quantityBaseUnits,
      });
    }
    const firstAllocation = batchAllocations[0];
    if (!firstAllocation) return null;
    const candidate: unknown = {
      productId: item.medicineId,
      productName: item.productName,
      genericName: item.genericName,
      batchId: firstAllocation.batchId,
      batchNumber: firstAllocation.batchNumber,
      expiryDate: firstAllocation.expiryDate,
      drugClass: item.drugClass,
      unitId: item.unitId,
      unitName: item.unitName,
      conversionFactor: item.conversionFactor,
      quantityInUnit: item.quantityInUnit,
      mrpPaisaPerUnit: item.pricePaisaPerUnit,
      costPaisaPerUnit: null,
      discountPercent: 0,
      lineTotalPaisa: item.lineTotalPaisa,
      batchAllocations,
    };
    return isCartItem(candidate) ? candidate : null;
  });
  const parsedItems = items.filter((item): item is CartItem => item !== null);
  if (parsedItems.length !== value.items.length) return null;

  const sale = {
    id: value.id,
    invoiceNumber: value.invoiceNumber,
    timestamp: value.timestamp,
    cashierName: value.cashierName,
    customerId: value.customerId,
    customerName: value.customerName,
    customerPhone: value.customerPhone,
    items: parsedItems,
    subtotalPaisa: value.subtotalPaisa,
    discountPaisa: value.discountPaisa,
    totalPaisa: value.totalPaisa,
    roundingPaisa: value.roundingPaisa,
    paymentMethod: value.paymentMethod,
    amountTenderedPaisa: value.amountTenderedPaisa,
    changePaisa: value.changePaisa,
  };
  return isCompletedSale(sale) ? sale : null;
}

export async function callSupabaseRpc<T>(
  name: string,
  args: Record<string, unknown> | undefined,
  fallback: string,
  validate: (value: unknown) => value is T,
): Promise<T> {
  if (!supabase) {
    throw new Error(getSupabaseErrorMessage(new Error('Supabase is not configured.'), fallback));
  }
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(getSupabaseErrorMessage(error, fallback));
  if (!validate(data)) {
    throw new Error(getSupabaseErrorMessage(new Error(`${name} returned an invalid response.`), fallback));
  }
  return data;
}

export async function loadPosCustomers(): Promise<Customer[]> {
  if (getBackend() === 'api') {
    const response = await apiRequest<unknown>('/api/pos/customers');
    if (!isRecord(response) || !hasExactKeys(response, ['items']) || !Array.isArray(response.items)) {
      throw new Error('The POS customer service returned an invalid response.');
    }
    const customers = response.items.map(parsePosCustomer);
    if (customers.some((customer) => customer === null)) {
      throw new Error('The POS customer service returned an invalid response.');
    }
    return customers.filter((customer): customer is Customer => customer !== null);
  }
  return callSupabaseRpc('pos_customers', undefined, 'Could not load POS customers.', (value): value is Customer[] =>
    Array.isArray(value) && value.every(isCustomer));
}

export async function loadCustomerAccountsSummary(): Promise<CustomerAccountsData> {
  if (getBackend() === 'api') {
    const response = await apiRequest<unknown>('/api/customers/accounts/summary');
    if (!isRecord(response)
      || !hasExactKeys(response, ['customers', 'ledgerEntries'])
      || !Array.isArray(response.customers) || !Array.isArray(response.ledgerEntries)) {
      throw new Error('The customer accounts service returned an invalid response.');
    }
    const customers = response.customers.map(parseApiCustomer);
    const entries = response.ledgerEntries.map(parseApiLedgerEntry);
    if (customers.some((customer) => customer === null) || entries.some((entry) => entry === null)) {
      throw new Error('The customer accounts service returned an invalid response.');
    }
    const ledgerEntries: CustomerAccountsData['ledgerEntries'] = {};
    for (const entry of entries) {
      if (!entry) continue;
      (ledgerEntries[entry.customerId] ??= []).push(entry);
    }
    return {
      customers: customers.filter((customer): customer is Customer => customer !== null),
      ledgerEntries,
    };
  }
  return callSupabaseRpc(
    'customer_accounts_summary',
    undefined,
    'Could not load customer accounts.',
    isCustomerAccountsData,
  );
}

export async function saveCustomer(input: {
  name: string;
  phone: string;
  cnic: string;
  address: string;
  creditLimitPaisa: number;
}): Promise<Customer> {
  if (getBackend() === 'api') {
    const response = await apiRequest<unknown>('/api/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        phone: input.phone,
        cnic: input.cnic || null,
        address: input.address,
        creditLimitPaisa: String(input.creditLimitPaisa),
      }),
    });
    const customer = parseApiCustomer(response);
    if (!customer) throw new Error('The customer service returned an invalid response.');
    return customer;
  }
  return callSupabaseRpc('save_customer', {
    p_name: input.name,
    p_phone: input.phone,
    p_cnic: input.cnic || null,
    p_address: input.address,
    p_credit_limit_paisa: input.creditLimitPaisa,
  }, 'Could not save customer.', isCustomer);
}

export async function recordCustomerPayment(
  customerId: string,
  amountPaisa: number,
  note: string,
): Promise<CustomerPaymentResult> {
  if (getBackend() === 'api') {
    const response = await apiRequest<unknown>(`/api/customers/${encodeURIComponent(customerId)}/payments`, {
      method: 'POST',
      body: JSON.stringify({ amountPaisa: String(amountPaisa), method: 'CASH', note }),
    });
    if (!isRecord(response)
      || !hasExactKeys(response, ['referenceNo', 'dateTime', 'balanceAfterPaisa', 'storeCreditPaisa'])
      || !isString(response.referenceNo) || !isString(response.dateTime)) {
      throw new Error('The customer payment service returned an invalid response.');
    }
    const balanceAfterPaisa = apiPaisaNumber(response.balanceAfterPaisa);
    const storeCreditPaisa = apiPaisaNumber(response.storeCreditPaisa);
    if (balanceAfterPaisa === null || storeCreditPaisa === null) {
      throw new Error('The customer payment service returned an invalid response.');
    }
    return {
      referenceNo: response.referenceNo,
      dateTime: response.dateTime,
      balanceAfterPaisa,
      storeCreditPaisa,
    };
  }
  return callSupabaseRpc('record_customer_payment', {
    p_customer_id: customerId,
    p_amount_paisa: amountPaisa,
    p_note: note,
  }, 'Could not record customer payment.', (value): value is CustomerPaymentResult =>
    isRecord(value)
      && isString(value.referenceNo)
      && isString(value.dateTime)
      && isNonNegativeInteger(value.balanceAfterPaisa)
      && isNonNegativeInteger(value.storeCreditPaisa));
}

export async function postSale(input: PostSaleInput): Promise<CompletedSale> {
  if (getBackend() === 'api') {
    const method = (paymentMethod: PaymentMethod) => paymentMethod === PaymentMethod.CASH
      ? 'CASH'
      : paymentMethod === PaymentMethod.CREDIT ? 'CREDIT' : 'CARD';
    const response = await apiRequest<unknown>('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        ...(input.customerId ? { customerId: input.customerId } : {}),
        customerName: input.customerName,
        items: input.items.map((item) => ({
          medicineId: item.medicineId,
          unitId: item.unitId,
          quantityInUnit: item.quantityInUnit,
          ...(item.prescription ? { prescription: item.prescription } : {}),
        })),
        discountPaisa: String(input.discountPaisa),
        payments: input.payments.map((payment) => ({
          method: method(payment.paymentMethod),
          amountPaisa: String(payment.amountPaisa),
        })),
        amountTenderedPaisa: String(input.tenderedPaisa),
      }),
    });
    return parseApiSale(response);
  }
  const raw = await callSupabaseRpc('post_sale', {
    p_customer_id: input.customerId,
    p_customer_name: input.customerName,
    p_items: input.items.map((item) => ({
      medicine_id: item.medicineId,
      unit_id: item.unitId,
      quantity_in_unit: item.quantityInUnit,
    })),
    p_discount_paisa: input.discountPaisa,
    p_rounding_paisa: input.roundingPaisa,
    p_tendered_paisa: input.tenderedPaisa,
    p_payments: input.payments.map((payment) => ({
      payment_method: payment.paymentMethod,
      amount_paisa: payment.amountPaisa,
    })),
  }, 'Could not complete the sale.', isCompletedSale);
  return raw;
}

export async function loadSalesHistory(limit = 100): Promise<CompletedSale[]> {
  const raw = await callSupabaseRpc('sales_history', { p_limit: limit }, 'Could not load sales history.', (value): value is unknown[] =>
    Array.isArray(value));
  const parsed = raw.map(parseSaleHistory);
  if (parsed.some((sale) => sale === null)) {
    throw new Error(getSupabaseErrorMessage(
      new Error('Sales history returned an invalid response.'),
      'Could not load sales history.',
    ));
  }
  return parsed.filter((sale): sale is CompletedSale => sale !== null);
}
