import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDemoSeedAllowed,
  DEMO_BRANDS,
  DEMO_CATEGORIES,
  DEMO_CUSTOMERS,
  DEMO_MEDICINES,
  DEMO_SUPPLIERS,
} from './demo-seed.js';

test('demo seeding refuses nondevelopment runtime modes', () => {
  for (const mode of ['production', undefined, 'preview']) {
    assert.throws(
      () => assertDemoSeedAllowed({
        NODE_ENV: mode,
        DEMO_MODE: 'true',
        MONGO_APP_DB: 'pharmacare_demo',
      }),
      /DEMO_SEED_NONDEVELOPMENT_FORBIDDEN/,
    );
  }
});

test('demo seeding requires the explicit demo flag and a demo-only database name', () => {
  assert.throws(
    () => assertDemoSeedAllowed({
      NODE_ENV: 'development',
      DEMO_MODE: 'false',
      MONGO_APP_DB: 'pharmacare_demo',
    }),
    /DEMO_SEED_MODE_REQUIRED/,
  );
  assert.throws(
    () => assertDemoSeedAllowed({
      NODE_ENV: 'development',
      DEMO_MODE: 'true',
      MONGO_APP_DB: 'pharmacare',
    }),
    /DEMO_DATABASE_REQUIRED/,
  );
  assert.equal(assertDemoSeedAllowed({
    NODE_ENV: 'development',
    DEMO_MODE: 'true',
    MONGO_APP_DB: 'pharmacare_demo',
  }), 'pharmacare_demo');
});

test('demo fixtures are visibly synthetic and contain no stock, batch, or expiry records', () => {
  assert.ok([...DEMO_CATEGORIES, ...DEMO_BRANDS, ...DEMO_CUSTOMERS, ...DEMO_SUPPLIERS.map(({ name }) => name)]
    .every((name) => name.startsWith('DEMO -')));
  assert.equal(DEMO_MEDICINES.length, 5);
  assert.ok(DEMO_MEDICINES.every((medicine) => medicine.name.startsWith('DEMO -')));
  assert.ok(DEMO_MEDICINES.every((medicine) => /^\d+$/.test(medicine.pricePaisa)));
  assert.equal(DEMO_MEDICINES.find(({ drugClass }) => drugClass === 'CONTROLLED')?.requiresPrescription, true);
  assert.ok(DEMO_MEDICINES.every((medicine) => !('quantity' in medicine || 'batchNumber' in medicine || 'expiryDate' in medicine)));
});
