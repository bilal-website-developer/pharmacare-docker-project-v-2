# Starter catalog

`server/data/starter-catalog.json` contains 20 clearly fictional catalog examples for a new shop. It intentionally contains no retail price, purchase cost, stock quantity, batch, or expiry values.

The seed command imports by normalized medicine code and is safe to repeat:

```powershell
docker compose build api
docker compose up --detach api
docker compose exec api npm run seed:starter-catalog
```

Run it only after the first shop and its Super Admin exist. The command targets the configured `BOOTSTRAP_SHOP_SLUG`, rechecks that the actor is an active Super Admin for that shop, and scopes every query/write to that shop. It does not set shop IDs from a file or request.

New medicines are created inactive, with a single default sale unit whose integer-paisa price is zero. This prevents the sample entries from being sold before a shop owner reviews the data, sets real prices, and explicitly activates the products. The importer creates missing categories and manufacturers in the same Mongo transaction, records audit events, and creates no stock batches. Existing medicine codes are skipped without modifying their records. A failed transaction leaves no partial import.

The catalog data is synthetic test content, not a clinical formulary or recommendation. Confirm local regulatory, product identity, licensing, pricing, storage, and labeling requirements before entering real stock or using a product in sales.

Validation:

- `npm.cmd --prefix server run test:starter-catalog` validates the data shape, count, fictional identifiers, and absence of cost/price/stock fields.
- `docker compose run --build --rm --no-deps api-test` includes a real-Mongo import/re-import and forced mid-transaction failure test for Super Admin authorization, per-shop creation, rollback, inactive/zero-price defaults, audit writes, no stock records, and idempotency.
- The production image check
  `docker compose run --build --rm --no-deps --entrypoint node api -e "import('node:fs/promises').then(async ({readFile}) => { const rows = JSON.parse(await readFile('/app/data/starter-catalog.json', 'utf8')); console.log(JSON.stringify({starterCatalogEntries: rows.length})); })"`
  returned a count of 20.
