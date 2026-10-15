# MongoDB Migration Decisions

Decisions recorded while finishing the migration. Revisit a decision only when new evidence requires it.

## 2026-10-15

### Local development ports

- **Decision:** Vite remains on `3000`; a host-launched Fastify API defaults to `3001`; Compose explicitly binds Fastify to `3000` inside the private Docker network.
- **Alternatives:** Run both host processes on `3000` (port collision); publish the API container to the host; move the frontend port.
- **Reason:** Keep existing Vite behavior and keep Mongo/API services unpublished in Compose. The Vite dev proxy and `docs/DOCKER.md` describe the local target.

### Mongo app-user authentication database

- **Decision:** Authenticate the root user against `admin`; authenticate the least-privilege application user against its application database.
- **Alternatives:** Create the application user in `admin`; keep `authSource=admin` for both accounts.
- **Reason:** `mongo-init` creates the app user in the application database with only `readWrite` there. Real Compose logs showed code 18 `AuthenticationFailed` when the app URI incorrectly used `admin`.

### Transaction callback results

- **Decision:** Mongo transaction wrappers distinguish “callback was never completed” from a valid callback result of `undefined`.
- **Alternatives:** Require every transaction callback to return a sentinel object or a non-void value.
- **Reason:** Valid write workflows such as customer creation perform transactional inserts but return their DTO after the transaction. Rejecting `undefined` caused a real-Mongo `SALE_TRANSACTION_RESULT_MISSING` failure.

### Signed Int64 supplier balance deltas

- **Decision:** Keep nonnegative checks for paisa values and use a separately bounded signed Int64 conversion for ledger deltas.
- **Alternatives:** Convert all stored monetary values through a signed helper or represent a reversal as two updates.
- **Reason:** Purchase voids legitimately decrement a payable balance. The positive-only helper rejected the negative delta despite the value being a valid BSON Int64.

### Auth endpoint idempotency

- **Decision:** Require persisted idempotency keys for authenticated business writes. Keep `/api/auth/login`, `/api/auth/refresh`, and `/api/auth/logout` outside that business idempotency store.
- **Alternatives:** Persist response bodies for credential-bearing operations; build a separate encrypted/credential-safe replay protocol for session rotation.
- **Reason:** Login/refresh responses contain access tokens and refresh-cookie rotation has credential lifecycle side effects. Persisting ordinary idempotency response bodies would retain token material. This exception must remain explicit in the security review; do not claim that every HTTP write route uses the business idempotency store.
