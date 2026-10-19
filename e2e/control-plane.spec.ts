import { expect, test, type Page, type Route } from '@playwright/test';
import { randomInt, randomUUID } from 'node:crypto';

type Role = 'admin' | 'manager' | 'cashier';

interface FakeOptions {
  needsSetup?: boolean;
  role?: Role;
  status?: 'ok' | 'inactive' | 'suspended';
  banners?: Partial<Record<
    'renewal_notice' | 'warning' | 'inactive' | 'offline_warning' | 'clock_warning',
    boolean
  >>;
}

const emptyBanners = {
  renewal_notice: false,
  warning: false,
  inactive: false,
  offline_warning: false,
  clock_warning: false,
};

async function installFakeControlPlane(page: Page, options: FakeOptions = {}) {
  let needsSetup = options.needsSetup ?? false;
  let authenticated = false;
  let supportCode = '';
  const accessToken = randomUUID();
  let supportSessions: Array<Record<string, unknown>> = [];
  const role = options.role ?? 'admin';
  const permissions = role === 'cashier' ? ['pos', 'customers']
    : role === 'manager' ? [
      'pos', 'products', 'categories', 'suppliers', 'customers', 'sales_history',
      'purchase_history', 'purchases', 'stock_inventory', 'reports',
    ] : [];
  const user = {
    id: '64b000000000000000000001',
    username: 'e2e-user',
    email: 'e2e@example.test',
    fullName: 'E2E User',
    role,
    permissions,
  };
  const licenceStatus = {
    status: options.status ?? 'ok',
    banners: { ...emptyBanners, ...options.banners },
  };

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    const method = request.method();
    if (path === '/api/setup/status') {
      await route.fulfill({ json: { needsSetup } });
      return;
    }
    if (path === '/api/setup' && method === 'POST') {
      needsSetup = false;
      await route.fulfill({ json: { created: true } });
      return;
    }
    if (path === '/api/auth/refresh' && method === 'POST') {
      await route.fulfill(authenticated
        ? { json: { accessToken } }
        : { status: 401, json: { error: 'UNAUTHENTICATED' } });
      return;
    }
    if (path === '/api/auth/login' && method === 'POST') {
      authenticated = true;
      await route.fulfill({ json: { accessToken, user } });
      return;
    }
    if (path === '/api/auth/me') {
      await route.fulfill(authenticated
        ? { json: { user } }
        : { status: 401, json: { error: 'UNAUTHENTICATED' } });
      return;
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      authenticated = false;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (path === '/api/licence/status') {
      await route.fulfill({ json: licenceStatus });
      return;
    }
    if (path === '/api/support/sessions') {
      await route.fulfill({ json: { sessions: supportSessions } });
      return;
    }
    if (path === '/api/support/allow' && method === 'POST') {
      const session = {
        sessionId: '64b000000000000000000002',
        scope: 'diagnostics',
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        startedAt: null,
      };
      supportSessions = [session];
      supportCode = String(randomInt(100000, 1000000));
      await route.fulfill({
        json: {
          sessionId: session.sessionId,
          code: supportCode,
          scope: 'diagnostics',
          expiresAt: session.expiresAt,
        },
      });
      return;
    }
    if (path === '/api/support/end' && method === 'POST') {
      supportSessions = [];
      await route.fulfill({ json: { ended: true } });
      return;
    }
    if (path === '/api/sales' && method === 'POST') {
      await route.fulfill({ status: 423, json: { error: 'LICENCE_INACTIVE' } });
      return;
    }
    if (path === '/api/print-requests/pending-count') {
      await route.fulfill({ json: { count: 0 } });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

async function signIn(page: Page, role: Role = 'admin') {
  await page.goto('/login');
  await page.getByLabel('EMAIL').fill(`${role}@example.test`);
  await page.getByLabel('PASSWORD', { exact: true }).fill(await makeEphemeralPassword(page));
  await page.getByRole('button', { name: 'Sign In to System' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}

async function makeEphemeralPassword(page: Page): Promise<string> {
  return page.evaluate(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return `Aa1!${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  });
}

test('first-run setup presents activation and one-time setup code fields', async ({ page }) => {
  await installFakeControlPlane(page, { needsSetup: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up this pharmacy' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Activation code' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'One-time setup code' })).toBeVisible();

  await page.getByLabel('Pharmacy name').fill('E2E Pharmacy');
  await page.getByLabel('Phone').fill('03000000000');
  await page.getByLabel('Shop time zone').fill('Asia/Karachi');
  await page.getByLabel('Address').fill('Test Street');
  await page.getByLabel('Username').fill('owner');
  await page.getByLabel('Full name').fill('Test Owner');
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
  const password = await makeEphemeralPassword(page);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByLabel('Enter the one-time activation code from the shop owner').fill(randomUUID().replaceAll('-', ''));
  await page.getByLabel('Enter the code shown by the installer').fill(randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''));
  await page.getByRole('button', { name: 'Complete setup' }).click();
  await expect(page.getByText('Sign in with your new admin account.')).toBeVisible();
});

test('admin and manager see the correct licence banners; all states render', async ({ page }) => {
  await installFakeControlPlane(page, {
    role: 'admin',
    status: 'suspended',
    banners: {
      renewal_notice: true,
      warning: true,
      inactive: true,
      offline_warning: true,
      clock_warning: true,
    },
  });
  await signIn(page);
  await expect(page.getByText(/nearing expiry/)).toBeVisible();
  await expect(page.getByText(/warning period/)).toBeVisible();
  await expect(page.getByText(/shop is suspended/)).toBeVisible();
  await expect(page.getByText(/offline beyond its grace period/)).toBeVisible();
  await expect(page.getByText(/device clock moved backwards/)).toBeVisible();

  await page.route('**/api/licence/status', async (route) => {
    await route.fulfill({
      json: {
        status: 'ok',
        banners: { ...emptyBanners, warning: true },
      },
    });
  });
  await page.reload();
  await expect(page.getByText(/warning period/)).toBeVisible();
});

test('manager sees warning banners but not the admin-only renewal reminder', async ({ page }) => {
  await installFakeControlPlane(page, {
    role: 'manager',
    banners: { renewal_notice: false, warning: true },
  });
  await signIn(page, 'manager');
  await expect(page.getByText(/warning period/)).toBeVisible();
  await expect(page.getByText(/nearing expiry/)).toHaveCount(0);
});

test('support approval displays a one-time code and End session removes it', async ({ page }) => {
  await installFakeControlPlane(page);
  await signIn(page);
  await page.getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Allow support' }).click();
  await expect(page.getByRole('heading', { name: 'Allow support' })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Allow support', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'One-time support code' })).toBeVisible();
  await expect(page.getByLabel('Six-digit support code')).toHaveText(/^\d{6}$/);
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByText('There are no active or recently ended sessions.')).toBeVisible();
});

test('manager inactive mode preserves reports and blocks sale writes', async ({ page }) => {
  await installFakeControlPlane(page, {
    role: 'manager',
    status: 'inactive',
    banners: { inactive: true },
  });
  await signIn(page, 'manager');
  await expect(page.getByText(/licence is inactive/)).toBeVisible();
  await page.getByRole('button', { name: 'Business Analytics' }).click();
  await expect(page.getByText('Gross Sales Revenue')).toBeVisible();
  const blockedWrite = await page.evaluate(async () => fetch('/api/sales', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [] }),
    credentials: 'include',
  }).then((response) => response.status));
  expect(blockedWrite).toBe(423);

});

test('cashier navigation omits admin screens and exposes no cost data or exports', async ({ page }) => {
  await installFakeControlPlane(page, { role: 'cashier' });
  await signIn(page, 'cashier');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('button', { name: 'POS Billing' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Allow support' })).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: 'Manage Users' })).toHaveCount(0);
  const accessibleScreens = await navigation.getByRole('button').all();
  for (const entry of accessibleScreens) {
    await entry.click();
    await expect(entry).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('body')).not.toContainText(/cost price|profit|margin/i);
    await expect(page.getByRole('button', { name: /export|download/i })).toHaveCount(0);
    await expect(page.locator('a[download]')).toHaveCount(0);
  }
});

test('browser keeps refresh cookies HttpOnly and Secure', async ({ page }) => {
  const refreshObservations: Array<{ protocol: string; sent: boolean }> = [];
  await page.route('**://cookie-test.example/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/login') {
      await route.fulfill({
        status: 204,
        headers: {
          'Set-Cookie': 'refresh=fixture; Path=/api/auth; HttpOnly; Secure; SameSite=Strict',
        },
      });
      return;
    }
    if (url.pathname === '/api/auth/refresh') {
      refreshObservations.push({
        protocol: url.protocol,
        sent: (request.headers().cookie ?? '').includes('refresh=fixture'),
      });
      await route.fulfill({ json: { refreshed: true } });
      return;
    }
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>cookie fixture</body></html>' });
  });

  await page.goto('https://cookie-test.example/');
  await page.evaluate(() => fetch('/login', { method: 'POST', credentials: 'include' }));
  await expect.poll(() => page.evaluate(() => document.cookie)).not.toContain('refresh=');
  await page.evaluate(() => fetch('/api/auth/refresh', { credentials: 'include' }));

  await page.goto('http://cookie-test.example/');
  await page.evaluate(() => fetch('/api/auth/refresh', { credentials: 'include' }));
  expect(refreshObservations).toEqual([
    { protocol: 'https:', sent: true },
    { protocol: 'http:', sent: false },
  ]);
});
