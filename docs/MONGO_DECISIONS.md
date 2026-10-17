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

- **Decision:** Require persisted idempotency keys for authenticated write routes except `/api/auth/login`, `/api/auth/refresh`, and `/api/auth/logout`. Password changes use the store because their response contains no credentials.
- **Alternatives:** Persist response bodies for credential-bearing operations; build a separate encrypted/credential-safe replay protocol for session rotation.
- **Reason:** Login/refresh responses contain access tokens and refresh-cookie rotation has credential lifecycle side effects. Persisting ordinary idempotency response bodies would retain token material. This exception must remain explicit in the security review; do not claim that every HTTP write route uses the business idempotency store.

### Return review sequencing

- **Decision:** In API mode, keep return approval and return processing as separate actions so the screen follows the server's `PENDING` → `APPROVED` → `COMPLETED` state transitions. Preserve the legacy Supabase flow as-is.
- **Reason:** Processing is transactional and only accepts an approved return; an explicit approval action avoids presenting a client-side combined action that the API cannot honor atomically.
- **Alternatives:** Combine approval and processing in one screen action or retain the prior client-side combined transition.

### Local Docker API proxy default

- **Decision:** Keep the Vite dev proxy pointed at `http://127.0.0.1:3000` by default and allow `VITE_API_PROXY_TARGET` to override it for direct host-mode Fastify development on `http://127.0.0.1:3001`.
- **Alternatives:** Hardcode the proxy to `:3001` everywhere; hardcode it to `:3000` everywhere; publish the API port in Compose.
- **Reason:** Docker Compose runs the API on port 3000 inside the private network, while direct host development often runs Fastify on 3001. The default proxy should match the Compose runtime without preventing local host-mode debugging.

## 2026-10-17

### One-time first-run setup code

- **Decision:** The setup API accepts a plaintext code only over the local setup form, compares its SHA-256 digest in constant time against `SETUP_CODE_HASH`, enforces `SETUP_CODE_EXPIRES_AT`, and atomically consumes a unique Mongo setup marker with the first shop/Super Admin transaction. The future installer generates and displays the code and must not log or persist its plaintext.
- **Alternatives:** Leave bootstrap as CLI-only; store the plaintext code in Mongo; allow setup without a code on a private network.
- **Reason:** Provide a guided shop-PC setup while retaining one-time use, bounded validity, and no stored plaintext bootstrap credential. The installer lifecycle and end-user experience remain to be implemented/tested.

### Starter catalog safety defaults

- **Decision:** Keep the 20-entry starter catalog fictional and free of price/cost/stock/batch/expiry values. Import only missing medicine codes in a Mongo transaction, create inactive products with zero-paisa default units, and skip existing codes without overwriting shop data.
- **Alternatives:** Import as active products; invent default prices or stock; update existing matching codes during a repeat import.
- **Reason:** Avoid accidental sales, fabricated financial/inventory data, and destructive overwrites while still giving a shop an optional structured starting catalog. Owners must validate identities, set actual prices, and explicitly activate items.

### API security defaults

- **Decision:** Allow one normalized `WEB_ORIGIN`; rate-limit by HMAC(IP, method, route, minute) with 120 reads, 60 writes, and 30 auth requests per window; retain the stricter login cap of 10 and five-failure account lockout. Persist general request counters in Mongo with TTL expiry. Test-mode apps use an injected rate-limit store so unit tests cannot unexpectedly access Mongo.
- **Alternatives:** Wildcard/multi-origin CORS; in-memory-only limits; shared unkeyed IP/route identifiers; applying the production Mongo store implicitly to tests.
- **Reason:** Restrict browser access, keep rate-limit keys non-reversible, bound abuse across API instances, and keep ordinary test setup isolated. The persisted store's distributed load/race behavior is not covered by the current test suite.

### API and Nginx security headers

- **Decision:** Apply `nosniff`, frame denial, strict referrer/permissions policy, same-origin resource policy, and a JSON-only API CSP. Nginx hides overlapping API headers before applying its own copy, avoiding duplicate response fields. Do not add a global frontend CSP until legacy external origins have been inventoried.
- **Alternatives:** Duplicate upstream/proxy headers; apply the API's restrictive CSP to the React frontend; omit headers on static responses.
- **Reason:** Keep a consistent single header value through the local proxy while avoiding a CSP that would break the retained Supabase path.
