import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseStarterCatalog } from './starter-catalog.js';

test('the starter catalog contains 20 clearly fictional entries without price, cost, or stock', async () => {
  const text = await readFile(new URL('../data/starter-catalog.json', import.meta.url), 'utf8');
  const rawEntries: unknown = JSON.parse(text);
  assert.ok(Array.isArray(rawEntries));
  for (const entry of rawEntries) {
    assert.ok(typeof entry === 'object' && entry !== null && !Array.isArray(entry));
    assert.equal(Object.keys(entry).some((key) => /(cost|price|stock|quantity|batch|expiry)/i.test(key)), false);
  }
  const entries = parseStarterCatalog(rawEntries);

  assert.equal(entries.length, 20);
  assert.equal(new Set(entries.map((entry) => entry.code.toLowerCase())).size, 20);
  assert.ok(entries.every((entry) => entry.code.startsWith('DEMO-')));
  assert.ok(entries.every((entry) => entry.name.startsWith('Demo Compound ')));
  assert.ok(entries.every((entry) => entry.genericName.startsWith('Demo Ingredient ')));
});

test('starter catalog schema rejects financial and inventory fields and duplicate medicine codes', () => {
  const base = {
    code: 'DEMO-TEST',
    name: 'Demo Compound Test',
    genericName: 'Demo Ingredient Test',
    category: 'Demo Category',
    manufacturer: 'Demo Manufacturer',
    drugClass: 'OTC',
    unitName: 'tablet',
    conversionFactorBaseUnits: 1,
  };

  assert.throws(() => parseStarterCatalog([{ ...base, pricePaisa: '100' }]));
  assert.throws(() => parseStarterCatalog([{ ...base, quantity: 10 }]));
  assert.throws(() => parseStarterCatalog([base, { ...base, code: 'demo-test' }]));
});
