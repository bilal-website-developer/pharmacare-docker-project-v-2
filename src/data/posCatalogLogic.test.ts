import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { clearApiAccessToken } from '../api/client';
import { BatchStatus, DrugClass } from '../types/pharmacy';
import { getRequiredSmallestUnits, isPosCatalogResponse } from './posCatalogLogic';
import { loadPosCatalog } from './posCatalog';

const originalFetch = globalThis.fetch;

const product = {
  id: 'medicine-1',
  code: 'MED-001',
  barcode: null,
  brandName: 'Medicine One',
  genericName: 'Generic One',
  strength: '10 mg',
  category: 'Pain Relief',
  company: 'Example Pharma',
  drugClass: DrugClass.OTC,
  units: [{
    id: 'unit-1',
    name: 'Pack',
    conversionFactor: 10,
    isDefaultSaleUnit: true,
    pricePerUnitPaisa: 5000,
  }],
  batches: [{
    id: 'batch-1',
    batchNumber: 'LOT-1',
    expiryDate: '2027-12-31',
    receivedDate: '2026-10-01',
    quantitySmallestUnit: 20,
    status: BatchStatus.ACTIVE,
  }],
};

function apiProduct() {
  return {
    id: 'medicine-1',
    code: 'MED-001',
    barcode: null,
    name: 'Medicine One',
    genericName: 'Generic One',
    strength: '10 mg',
    category: 'Pain Relief',
    company: 'Example Pharma',
    drugClass: 'OTC',
    requiresPrescription: false,
    stockBaseUnits: '20',
    units: [{
      id: 'unit-1',
      name: 'Pack',
      conversionFactorBaseUnits: 10,
      pricePaisa: '5000',
      isDefaultSaleUnit: true,
      barcode: null,
    }],
    batches: [{
      id: 'batch-1',
      batchNumber: 'LOT-1',
      expiryDate: '2027-12-31',
      receivedDate: '2026-10-01',
      quantityBaseUnits: '20',
      status: 'ACTIVE',
    }],
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearApiAccessToken();
});

test('POS catalog response guard accepts safe catalog rows', () => {
  assert.equal(isPosCatalogResponse([product]), true);
  assert.equal(isPosCatalogResponse([]), true);
});

test('POS catalog response guard rejects malformed or cost-bearing fields', () => {
  assert.equal(isPosCatalogResponse([{ ...product, units: [] }]), false);
  assert.equal(isPosCatalogResponse([{
    ...product,
    batches: [{ ...product.batches[0], costPaisaPerUnit: 100 }],
  }]), false);
  assert.equal(isPosCatalogResponse([{
    ...product,
    units: [{ ...product.units[0], supplierName: 'Supplier' }],
  }]), false);
  assert.equal(isPosCatalogResponse([{
    ...product,
    batches: [{ ...product.batches[0], quantitySmallestUnit: '20' }],
  }]), false);
});

test('converts POS cart units into base tablet quantities', () => {
  assert.equal(getRequiredSmallestUnits(1, 1), 1);
  assert.equal(getRequiredSmallestUnits(1, 10), 10);
  assert.equal(getRequiredSmallestUnits(1, 100), 100);
  assert.equal(getRequiredSmallestUnits(2, 10), 20);
  assert.throws(() => getRequiredSmallestUnits(0, 10), RangeError);
  assert.throws(() => getRequiredSmallestUnits(2, Number.MAX_SAFE_INTEGER), RangeError);
});

test('loads API catalog data and maps exact integer strings to the POS model', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), '/api/pos/catalog');
    assert.equal(init?.credentials, 'include');
    return Response.json({ today: '2026-10-15', items: [apiProduct()] });
  };

  const [loaded] = await loadPosCatalog();

  assert.equal(loaded.catalogToday, '2026-10-15');
  assert.equal(loaded.brandName, 'Medicine One');
  assert.equal(loaded.company, 'Example Pharma');
  assert.equal(loaded.units[0].pricePerUnitPaisa, 5000);
  assert.equal(loaded.batches[0].quantitySmallestUnit, 20);
  assert.equal(loaded.batches[0].productId, 'medicine-1');
});

test('rejects API catalog data containing unexpected cost-bearing fields', async () => {
  globalThis.fetch = async () => Response.json({
    today: '2026-10-15',
    items: [{
      ...apiProduct(),
      units: [{ ...apiProduct().units[0], costPaisaPerUnit: '1000' }],
    }],
  });

  await assert.rejects(loadPosCatalog(), /invalid response/i);
});

test('rejects API integer strings that cannot be represented safely in the POS UI', async () => {
  globalThis.fetch = async () => Response.json({
    today: '2026-10-15',
    items: [{
      ...apiProduct(),
      units: [{ ...apiProduct().units[0], pricePaisa: '9007199254740992' }],
    }],
  });

  await assert.rejects(loadPosCatalog(), /invalid response/i);
});
