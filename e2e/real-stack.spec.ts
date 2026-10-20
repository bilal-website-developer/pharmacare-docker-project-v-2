import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const baseURL = process.env.REAL_STACK_BASE_URL;
const setupCode = process.env.REAL_STACK_SETUP_CODE;
const activationCode = process.env.REAL_STACK_ACTIVATION_CODE;
const adminPassword = process.env.REAL_STACK_ADMIN_PASSWORD;
const adminEmail = process.env.REAL_STACK_ADMIN_EMAIL;

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for the real-stack test.`);
  return value;
}

async function jsonRequest(
  request: APIRequestContext,
  path: string,
  accessToken: string,
  method = 'GET',
  data?: unknown,
) {
  return request.fetch(new URL(path, required(baseURL, 'REAL_STACK_BASE_URL')).toString(), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}),
    },
    ...(data === undefined ? {} : { data }),
  });
}

async function signIn(page: Page, email: string, password: string): Promise<string> {
  const loginResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/auth/login'
      && response.request().method() === 'POST',
  );
  await page.goto('/login');
  await page.getByLabel('EMAIL').fill(email);
  await page.getByLabel('PASSWORD', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In to System' }).click();
  const loginResponse = await loginResponsePromise;
  expect(loginResponse.status()).toBe(200);
  const responseBody = await loginResponse.json() as { accessToken?: unknown };
  expect(typeof responseBody.accessToken).toBe('string');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  return responseBody.accessToken as string;
}

test('real Compose shop setup, roles, purchase, discounted POS sale, return and cashier redaction', async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const shopURL = required(baseURL, 'REAL_STACK_BASE_URL');
  const password = required(adminPassword, 'REAL_STACK_ADMIN_PASSWORD');
  const roles = [
    {
      username: `manager-${randomUUID().slice(0, 8)}`,
      role: 'manager',
      permissions: [
        'pos', 'products', 'categories', 'suppliers', 'customers', 'sales_history',
        'purchase_history', 'purchases', 'stock_inventory', 'reports',
      ],
    },
    {
      username: `cashier-${randomUUID().slice(0, 8)}`,
      role: 'cashier',
      permissions: ['pos', 'customers'],
    },
    {
      username: `accountant-${randomUUID().slice(0, 8)}`,
      role: 'accountant',
      permissions: ['customers', 'suppliers', 'sales_history', 'purchase_history', 'expenses', 'reports'],
    },
  ] as const;
  const credentials = new Map<string, { email: string; password: string }>();

  await page.goto(shopURL);
  await expect(page.getByRole('heading', { name: 'Set up this pharmacy' })).toBeVisible();
  await page.getByLabel('Pharmacy name').fill('Real Stack Test Pharmacy');
  await page.getByLabel('Phone').fill('03000000000');
  await page.getByLabel('Shop time zone').fill('Asia/Karachi');
  await page.getByLabel('Address').fill('Disposable test site');
  await page.getByLabel('Username').fill(`owner-${randomUUID().slice(0, 8)}`);
  await page.getByLabel('Full name').fill('Real Stack Owner');
  const bootstrapEmail = required(adminEmail, 'REAL_STACK_ADMIN_EMAIL');
  await page.getByLabel('Email', { exact: true }).fill(bootstrapEmail);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByLabel('Enter the one-time activation code from the shop owner')
    .fill(required(activationCode, 'REAL_STACK_ACTIVATION_CODE'));
  await page.getByLabel('Enter the code shown by the installer')
    .fill(required(setupCode, 'REAL_STACK_SETUP_CODE'));
  const setupResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/setup'
      && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Complete setup' }).click();
  const setupResponse = await setupResponsePromise;
  if (setupResponse.status() !== 200 && setupResponse.status() !== 201) {
    const messages = (await page.getByRole('alert').allTextContents()).join(' | ');
    const responseBody = await setupResponse.json().catch(() => null) as { error?: unknown } | null;
    const errorCode = typeof responseBody?.error === 'string' ? responseBody.error : 'UNKNOWN';
    throw new Error(
      `Real-stack setup returned HTTP ${setupResponse.status()} (${errorCode}); visible messages: ${messages}`,
    );
  }
  await expect(page.getByText('Setup complete. Sign in with your new admin account.')).toBeVisible();

  const adminToken = await signIn(page, bootstrapEmail, password);
  for (const role of roles) {
    const email = `${role.username}@example.test`;
    const rolePassword = randomBytes(24).toString('base64url');
    const response = await jsonRequest(request, '/api/users', adminToken, 'POST', {
      username: role.username,
      email,
      fullName: `E2E ${role.role}`,
      password: rolePassword,
      role: role.role,
      permissions: [...role.permissions],
      isActive: true,
    });
    expect(response.status()).toBe(201);
    credentials.set(role.role, { email, password: rolePassword });
  }

  const category = await jsonRequest(request, '/api/categories', adminToken, 'POST', {
    name: `Real E2E ${randomUUID().slice(0, 8)}`,
  });
  expect(category.status()).toBe(201);
  const categoryId = ((await category.json()) as { id: string }).id;
  const brand = await jsonRequest(request, '/api/brands', adminToken, 'POST', {
    name: `Real E2E Brand ${randomUUID().slice(0, 8)}`,
  });
  expect(brand.status()).toBe(201);
  const brandId = ((await brand.json()) as { id: string }).id;
  const medicineCode = `E2E-${randomUUID().slice(0, 8)}`;
  const medicineResponse = await jsonRequest(request, '/api/medicines', adminToken, 'POST', {
    code: medicineCode,
    name: 'Real E2E Medicine',
    genericName: 'Real E2E Ingredient',
    categoryId,
    brandId,
    drugClass: 'OTC',
    storageCondition: 'ROOM_TEMPERATURE',
    units: [{
      name: 'Tablet',
      conversionFactorBaseUnits: 1,
      pricePaisa: '10000',
      isDefaultSaleUnit: true,
    }],
  });
  expect(medicineResponse.status()).toBe(201);
  const medicine = await medicineResponse.json() as {
    id: string;
    units: Array<{ id: string }>;
  };
  const supplierResponse = await jsonRequest(request, '/api/suppliers', adminToken, 'POST', {
    name: `Real E2E Supplier ${randomUUID().slice(0, 8)}`,
    paymentTerms: 'Cash on delivery',
  });
  expect(supplierResponse.status()).toBe(201);
  const supplierId = ((await supplierResponse.json()) as { id: string }).id;
  const catalogResponse = await jsonRequest(request, '/api/pos/catalog', adminToken);
  expect(catalogResponse.status()).toBe(200);
  const today = ((await catalogResponse.json()) as { today: string }).today;
  const expiry = new Date(`${today}T00:00:00.000Z`);
  expiry.setUTCFullYear(expiry.getUTCFullYear() + 1);
  const purchaseResponse = await jsonRequest(request, '/api/purchases', adminToken, 'POST', {
    supplierId,
    invoiceNumber: `E2E-${randomUUID().slice(0, 8)}`,
    purchaseDate: today,
    paymentType: 'cash',
    discountPaisa: '0',
    notes: 'Disposable real-stack verification',
    items: [{
      medicineId: medicine.id,
      unitId: medicine.units[0].id,
      batchNumber: `E2E-${randomUUID().slice(0, 8)}`,
      expiryDate: expiry.toISOString().slice(0, 10),
      quantity: 20,
      bonusQuantity: 0,
      unitCostPaisa: '6000',
      mrpPaisa: '10000',
    }],
  });
  expect(purchaseResponse.status()).toBe(201);

  const purchaseExport = await jsonRequest(request, '/api/purchases/export', adminToken);
  expect(purchaseExport.status()).toBe(200);
  expect(JSON.stringify(await purchaseExport.json())).toMatch(/unitCostPaisa|unit_cost_paisa/i);

  const manager = credentials.get('manager');
  expect(manager).toBeTruthy();
  const managerContext = await browser.newContext({ baseURL: shopURL });
  const managerPage = await managerContext.newPage();
  await signIn(managerPage, manager!.email, manager!.password);
  let saleRequestCount = 0;
  managerPage.on('request', (requestEvent) => {
    if (new URL(requestEvent.url()).pathname === '/api/sales' && requestEvent.method() === 'POST') {
      saleRequestCount += 1;
    }
  });
  const saleRequestPromise = managerPage.waitForRequest((requestEvent) =>
    new URL(requestEvent.url()).pathname === '/api/sales'
      && requestEvent.method() === 'POST',
  );
  await managerPage.goto(new URL('/pos', shopURL).toString());
  await managerPage.getByPlaceholder('Search products / brand (F2)...').fill(medicineCode);
  await managerPage.getByRole('button', { name: /Real E2E Brand/ }).click();
  await managerPage.getByLabel('Cart discount amount').fill('1.00');
  await expect(managerPage.getByLabel('Cart discount amount')).toHaveValue('1.00');
  await managerPage.getByRole('button', { name: /Charge Rs/ }).click();
  await managerPage.getByRole('button', { name: /Exact \(Rs\./ }).last().click();
  const saleResponsePromise = managerPage.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/sales'
      && response.request().method() === 'POST',
  );
  await managerPage.getByRole('button', { name: /Complete Sale/ }).click();
  const saleRequest = await saleRequestPromise;
  const postedSaleRequest = saleRequest.postDataJSON() as { discountPaisa?: string };
  expect(BigInt(postedSaleRequest.discountPaisa ?? '0')).toBeGreaterThan(0n);
  const saleResponse = await saleResponsePromise;
  if (saleResponse.status() !== 201) {
    const payload = saleRequest.postDataJSON() as Record<string, unknown>;
    const items = Array.isArray(payload.items) ? payload.items : [];
    const payments = Array.isArray(payload.payments) ? payload.payments : [];
    let errorCode = 'unknown';
    try {
      const responseBody = await saleResponse.json() as { error?: unknown };
      if (typeof responseBody.error === 'string') errorCode = responseBody.error;
    } catch {
      errorCode = 'non-JSON response';
    }
    const salesHistory = await jsonRequest(request, '/api/sales/history', adminToken);
    const historyBody = await salesHistory.json() as { items?: unknown };
    const persistedSales = Array.isArray(historyBody.items) ? historyBody.items.length : -1;
    throw new Error(
      `Sale API returned HTTP ${saleResponse.status()} (${errorCode}); `
      + `payload keys=${Object.keys(payload).sort().join(',')}; `
      + `item keys=${Object.keys((items[0] ?? {}) as Record<string, unknown>).sort().join(',')}; `
      + `payment keys=${Object.keys((payments[0] ?? {}) as Record<string, unknown>).sort().join(',')}; `
      + `observed sale POSTs=${saleRequestCount}; persisted sale count=${persistedSales}`,
    );
  }
  const sale = await saleResponse.json() as {
    id: string;
    discountPaisa: string;
    items: Array<{
      id: string;
      batchAllocations: Array<{ batchId: string }>;
    }>;
  };
  expect(BigInt(sale.discountPaisa)).toBeGreaterThan(0n);
  expect(JSON.stringify(sale)).not.toMatch(/cost|profit|margin/i);
  const saleItem = sale.items[0];
  const allocation = saleItem.batchAllocations[0];
  expect(saleItem).toBeTruthy();
  expect(allocation).toBeTruthy();

  const returnRequest = await jsonRequest(request, `/api/sales/${sale.id}/returns`, adminToken, 'POST', {
    reason: 'Disposable real-stack return',
    items: [{
      saleItemId: saleItem.id,
      allocationId: `${saleItem.id}:${allocation.batchId}`,
      quantityBaseUnits: 1,
    }],
  });
  expect(returnRequest.status()).toBe(201);
  const returnRecord = await returnRequest.json() as { id: string; items: Array<{ id: string }> };
  const approvedReturn = await jsonRequest(
    request,
    `/api/returns/${returnRecord.id}/approve`,
    adminToken,
    'POST',
    { note: 'Approved in real-stack test' },
  );
  expect(approvedReturn.status()).toBe(200);
  const processedReturn = await jsonRequest(
    request,
    `/api/returns/${returnRecord.id}/process`,
    adminToken,
    'POST',
    {
      items: returnRecord.items.map((item) => ({
        id: item.id,
        disposition: 'QUARANTINE',
        sealedIntact: false,
        restockUnitId: null,
        reason: 'Quarantine test return',
      })),
    },
  );
  expect(processedReturn.status()).toBe(200);

  const cashier = credentials.get('cashier');
  expect(cashier).toBeTruthy();
  const cashierContext = await browser.newContext({ baseURL: shopURL });
  const cashierPage = await cashierContext.newPage();
  const cashierToken = await signIn(cashierPage, cashier!.email, cashier!.password);
  const cashierResponses = await Promise.all([
    jsonRequest(request, '/api/pos/catalog', cashierToken),
    jsonRequest(request, '/api/dashboard/summary', cashierToken),
    jsonRequest(request, '/api/customers', cashierToken),
    jsonRequest(request, '/api/customers/accounts/summary', cashierToken),
    jsonRequest(request, '/api/sales/draft-token', cashierToken),
  ]);
  for (const response of cashierResponses) {
    expect(response.status()).toBe(200);
    expect(await response.text()).not.toMatch(/cost|profit|margin/i);
  }
  for (const path of [
    '/api/purchases/export',
    '/api/purchases/history',
    '/api/stock/overview',
    '/api/medicines',
    '/api/sales/history',
  ]) {
    const denied = await jsonRequest(request, path, cashierToken);
    expect(denied.status()).toBe(403);
    expect(await denied.text()).not.toMatch(/cost|profit|margin/i);
  }
});
