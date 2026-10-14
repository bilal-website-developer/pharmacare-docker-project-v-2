import { ObjectId } from 'mongodb';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuditRecord, PharmacyRepository, UserRecord } from './models.js';
import { requireAuth, requirePermission } from './auth-routes.js';
import type { TokenConfig } from './auth-crypto.js';
import type { IdempotencyStore } from './idempotency.js';
import {
  customerCreateSchema,
  customerListQuerySchema,
  customerPaymentSchema,
  customerUpdateSchema,
  normalizedCustomerName,
  postSaleSchema,
  salesHistoryQuerySchema,
  timezoneToday,
  type CustomerRecord,
  type SaleRecord,
} from './sales-domain.js';
import type { SalesRepository } from './sales-repository.js';

const idSchema = z.string().regex(/^[a-f\d]{24}$/i);

function caller(request: FastifyRequest, reply: FastifyReply): UserRecord | null {
  if (!request.authUser) {
    void reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return null;
  }
  return request.authUser;
}

function audit(
  actor: UserRecord,
  event: string,
  entityType: string,
  entityId?: ObjectId,
  after?: Record<string, unknown>,
): AuditRecord {
  return {
    shopId: actor.shopId,
    actorId: actor._id,
    ...(entityId ? { entityId } : {}),
    event,
    entityType,
    ...(after ? { after } : {}),
    occurredAt: new Date(),
  };
}

function customerDto(customer: CustomerRecord): Record<string, unknown> {
  return {
    id: customer._id.toHexString(),
    name: customer.name,
    phone: customer.phone,
    cnic: customer.cnic,
    address: customer.address,
    creditLimitPaisa: customer.creditLimitPaisa.toString(),
    currentBalancePaisa: customer.currentBalancePaisa.toString(),
    storeCreditPaisa: customer.storeCreditPaisa.toString(),
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
  };
}

function saleDto(sale: SaleRecord): Record<string, unknown> {
  return {
    id: sale._id.toHexString(),
    invoiceNumber: sale.invoiceNumber,
    timestamp: sale.soldAt.toISOString(),
    cashierName: sale.cashierName,
    customerId: sale.customerId?.toHexString() ?? null,
    customerName: sale.customerName,
    customerPhone: sale.customerPhone,
    subtotalPaisa: sale.subtotalPaisa.toString(),
    discountPaisa: sale.discountPaisa.toString(),
    totalPaisa: sale.totalPaisa.toString(),
    amountTenderedPaisa: sale.amountTenderedPaisa.toString(),
    changePaisa: sale.changePaisa.toString(),
    paymentMethod: sale.paymentMethod,
    status: sale.status,
    items: sale.items.map((item) => ({
      id: item._id.toHexString(),
      medicineId: item.medicineId.toHexString(),
      medicineCode: item.medicineCode,
      productName: item.medicineName,
      genericName: item.genericName,
      drugClass: item.drugClass,
      unitId: item.unitId.toHexString(),
      unitName: item.unitName,
      conversionFactor: item.conversionFactorBaseUnits,
      quantityInUnit: item.quantityInUnit,
      quantityBaseUnits: item.quantityBaseUnits.toString(),
      pricePaisaPerUnit: item.pricePaisaPerUnit.toString(),
      lineDiscountPaisa: item.lineDiscountPaisa.toString(),
      lineTotalPaisa: item.lineTotalPaisa.toString(),
      ...(item.prescription ? {
        prescription: {
          prescriber: item.prescription.prescriber,
          patient: item.prescription.patient,
          reference: item.prescription.reference,
        },
      } : {}),
      batchAllocations: item.batchAllocations.map((allocation) => ({
        batchId: allocation.batchId.toHexString(),
        batchNumber: allocation.batchNumber,
        expiryDate: allocation.expiryDate.toISOString().slice(0, 10),
        quantityBaseUnits: allocation.quantityBaseUnits.toString(),
      })),
    })),
  };
}

function saleListDto(sale: SaleRecord): Record<string, unknown> {
  return {
    id: sale._id.toHexString(),
    invoiceNumber: sale.invoiceNumber,
    timestamp: sale.soldAt.toISOString(),
    cashierName: sale.cashierName,
    customerId: sale.customerId?.toHexString() ?? null,
    customerName: sale.customerName,
    customerPhone: sale.customerPhone,
    subtotalPaisa: sale.subtotalPaisa.toString(),
    discountPaisa: sale.discountPaisa.toString(),
    totalPaisa: sale.totalPaisa.toString(),
    amountTenderedPaisa: sale.amountTenderedPaisa.toString(),
    changePaisa: sale.changePaisa.toString(),
    paymentMethod: sale.paymentMethod,
    status: sale.status,
    itemCount: sale.items.length,
    items: sale.items.map((item) => ({
      id: item._id.toHexString(),
      medicineId: item.medicineId.toHexString(),
      unitId: item.unitId.toHexString(),
      productName: item.medicineName,
      genericName: item.genericName,
      drugClass: item.drugClass,
      unitName: item.unitName,
      conversionFactor: item.conversionFactorBaseUnits,
      quantityInUnit: item.quantityInUnit,
      quantityBaseUnits: item.quantityBaseUnits.toString(),
      pricePaisaPerUnit: item.pricePaisaPerUnit.toString(),
      lineDiscountPaisa: item.lineDiscountPaisa.toString(),
      lineTotalPaisa: item.lineTotalPaisa.toString(),
      batchAllocations: item.batchAllocations.map((allocation) => ({
        batchId: allocation.batchId.toHexString(),
        batchNumber: allocation.batchNumber,
        expiryDate: allocation.expiryDate.toISOString().slice(0, 10),
        quantityBaseUnits: allocation.quantityBaseUnits.toString(),
      })),
    })),
  };
}

function errorResponse(error: unknown, reply: FastifyReply): FastifyReply | null {
  if (!(error instanceof Error)) return null;
  const responses: Record<string, { status: number; code: string }> = {
    INVALID_SHOP_TIMEZONE: { status: 500, code: 'INTERNAL_ERROR' },
    CUSTOMER_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
    CUSTOMER_HAS_BALANCE: { status: 409, code: 'CUSTOMER_HAS_BALANCE' },
    CUSTOMER_CHANGED_CONCURRENTLY: { status: 409, code: 'CUSTOMER_CHANGED_CONCURRENTLY' },
    PAYMENT_EXCEEDS_CUSTOMER_BALANCE: { status: 400, code: 'PAYMENT_EXCEEDS_CUSTOMER_BALANCE' },
    PRESCRIPTION_REQUIRED: { status: 400, code: 'PRESCRIPTION_REQUIRED' },
    MEDICINE_OR_UNIT_UNAVAILABLE: { status: 400, code: 'ITEM_UNAVAILABLE' },
    INVALID_UNIT_CONVERSION: { status: 400, code: 'ITEM_UNAVAILABLE' },
    SALE_QUANTITY_LIMIT_EXCEEDED: { status: 400, code: 'VALIDATION_FAILED' },
    SALE_TOTAL_LIMIT_EXCEEDED: { status: 400, code: 'VALIDATION_FAILED' },
    DISCOUNT_EXCEEDS_ROLE_LIMIT: { status: 400, code: 'DISCOUNT_EXCEEDS_ROLE_LIMIT' },
    INVALID_SALE_TOTAL: { status: 400, code: 'VALIDATION_FAILED' },
    PAYMENTS_MUST_EQUAL_TOTAL: { status: 400, code: 'PAYMENTS_MUST_EQUAL_TOTAL' },
    CREDIT_MUST_BE_SOLE_PAYMENT: { status: 400, code: 'CREDIT_MUST_BE_SOLE_PAYMENT' },
    CREDIT_TENDER_MUST_BE_ZERO: { status: 400, code: 'CREDIT_TENDER_MUST_BE_ZERO' },
    CREDIT_REQUIRES_CUSTOMER: { status: 400, code: 'CREDIT_REQUIRES_CUSTOMER' },
    CASH_TENDER_BELOW_TOTAL: { status: 400, code: 'CASH_TENDER_BELOW_TOTAL' },
    TENDER_MUST_EQUAL_TOTAL: { status: 400, code: 'TENDER_MUST_EQUAL_TOTAL' },
    STOCK_CHANGED_CONCURRENTLY: { status: 409, code: 'STOCK_CHANGED_CONCURRENTLY' },
    INSUFFICIENT_SELLABLE_STOCK: { status: 409, code: 'INSUFFICIENT_STOCK' },
    SALE_NUMBER_CONFLICT: { status: 409, code: 'SALE_NUMBER_CONFLICT' },
    NUMBER_SEQUENCE_UNAVAILABLE: { status: 500, code: 'INTERNAL_ERROR' },
  };
  const response = responses[error.message];
  if (!response) return null;
  return reply.code(response.status).send({ error: response.code });
}

export function registerSalesRoutes(
  app: FastifyInstance,
  repository: SalesRepository,
  authRepository: PharmacyRepository,
  tokenConfig: TokenConfig,
  idempotencyStore: IdempotencyStore,
): void {
  const pos = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('pos')];
  const customers = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('customers')];
  const salesHistory = [requireAuth(authRepository, tokenConfig, idempotencyStore), requirePermission('sales_history')];

  app.get('/api/pos/catalog', { preHandler: pos }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const shop = await authRepository.findShopById(user.shopId);
    if (!shop || shop.status !== 'ACTIVE') return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    return reply.send(await repository.posCatalog(
      user.shopId,
      timezoneToday(shop.timeZone ?? 'Asia/Karachi'),
    ));
  });

  app.post('/api/sales', { preHandler: pos }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = postSaleSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const shop = await authRepository.findShopById(user.shopId);
    if (!shop || shop.status !== 'ACTIVE') return reply.code(401).send({ error: 'UNAUTHENTICATED' });
    try {
      const sale = await repository.postSale(
        parsed.data,
        user,
        audit(user, 'sale.posted', 'sale'),
        timezoneToday(shop.timeZone ?? 'Asia/Karachi'),
      );
      return reply.code(201).send(saleDto(sale));
    } catch (error) {
      const handled = errorResponse(error, reply);
      if (handled) return handled;
      throw error;
    }
  });

  app.get('/api/customers/accounts/summary', { preHandler: customers }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const summary = await repository.customerAccountsSummary(user.shopId);
    return reply.send({
      customers: summary.customers.map(customerDto),
      ledgerEntries: summary.ledgerEntries,
    });
  });

  app.get('/api/customers', { preHandler: customers }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = customerListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const result = await repository.listCustomers(user.shopId, parsed.data);
    return reply.send({
      items: result.rows.map(customerDto),
      total: result.total,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
  });

  app.post('/api/customers', { preHandler: customers }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = customerCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    try {
      const customer = await repository.createCustomer(
        user.shopId,
        user._id,
        parsed.data,
        audit(user, 'customer.created', 'customer', undefined, { name: parsed.data.name }),
      );
      return reply.code(201).send(customerDto(customer));
    } catch (error) {
      const handled = errorResponse(error, reply);
      if (handled) return handled;
      throw error;
    }
  });

  app.patch('/api/customers/:id', { preHandler: customers }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const id = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = customerUpdateSchema.safeParse(request.body);
    if (!id.success || !parsed.success || Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    }
    try {
      const updated = await repository.updateCustomer(
        user.shopId,
        new ObjectId(id.data),
        user._id,
        parsed.data,
        audit(user, 'customer.updated', 'customer', new ObjectId(id.data), {
          ...(parsed.data.name ? { name: parsed.data.name, normalizedName: normalizedCustomerName(parsed.data.name) } : {}),
        }),
      );
      if (!updated) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(customerDto(updated));
    } catch (error) {
      const handled = errorResponse(error, reply);
      if (handled) return handled;
      throw error;
    }
  });

  app.delete('/api/customers/:id', { preHandler: customers }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const id = idSchema.safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const objectId = new ObjectId(id.data);
    try {
      const deleted = await repository.deleteCustomer(
        user.shopId,
        objectId,
        user._id,
        audit(user, 'customer.deleted', 'customer', objectId),
      );
      if (!deleted) return reply.code(404).send({ error: 'NOT_FOUND_OR_HAS_BALANCE' });
      return reply.send({ id: objectId.toHexString(), deleted: true });
    } catch (error) {
      const handled = errorResponse(error, reply);
      if (handled) return handled;
      throw error;
    }
  });

  app.post('/api/customers/:id/payments', { preHandler: customers }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const id = idSchema.safeParse((request.params as { id?: unknown }).id);
    const parsed = customerPaymentSchema.safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    try {
      const payment = await repository.recordCustomerPayment(
        user.shopId,
        new ObjectId(id.data),
        user,
        parsed.data,
        audit(user, 'customer.payment_recorded', 'customer', new ObjectId(id.data), {
          amountPaisa: parsed.data.amountPaisa,
          method: parsed.data.method,
        }),
      );
      if (!payment) return reply.code(404).send({ error: 'NOT_FOUND' });
      return reply.send(payment);
    } catch (error) {
      if (errorResponse(error, reply)) return;
      throw error;
    }
  });

  app.get('/api/sales/history', { preHandler: salesHistory }, async (request, reply) => {
    const user = caller(request, reply);
    if (!user) return;
    const parsed = salesHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const cashierId = user.role === 'cashier' ? user._id : undefined;
    const result = await repository.listSales(user.shopId, parsed.data, cashierId);
    return reply.send({
      items: result.rows.map(saleListDto),
      total: result.total,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });
  });
}
