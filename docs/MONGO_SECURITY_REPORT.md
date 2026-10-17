# MongoDB API Security Hardening Report

## Scope and conclusion

This report records automated and local Compose checks for the current `feature/mongo-migration` source. It is **not a penetration test**, security certification, or production deployment review. No live Supabase project was accessed, and no production service was deployed.

## Controls reviewed and tested

- Fastify allows only the configured normalized `WEB_ORIGIN`; the local Compose origin returned HTTP 200 for `/api/health`, while an unapproved origin returned HTTP 403 `ORIGIN_NOT_ALLOWED`.
- Request size is limited to 6 MiB in Fastify and Nginx. Excess payloads receive a generic 413 response.
- Request limits use HMAC-keyed per-IP, method, and normalized-route counters: 120 reads, 60 writes, and 30 auth requests per 60-second window. Login additionally has a 10-request limit and locks an account after five consecutive failures. Mongo expiry indexes are initialized for request counters.
- Request bodies, parameters, and query values are screened recursively for Mongo operator/prototype keys. Route schemas validate accepted input; a catalog test rejects a client-supplied `shopId`.
- The central error handler returns generic response codes and logs only safe error metadata. The Pino redaction test covers authorization/cookies, request keys, passwords, token/secret fields, URI fields, and error message/stack paths.
- API and Nginx response headers include content-type sniffing protection, frame denial, referrer and permissions policies, and same-origin resource policy. The API adds a restrictive JSON CSP and `no-store`; Nginx suppresses duplicate upstream copies of shared headers.
- Registered-route tests check missing-token rejection, cashier denial without permission, and cashier responses across every registered non-OPTIONS method/route. The response guard scans JSON fields/error text and CSV headers for cost/profit/margin fields. Existing auth tests cover login lockout; catalog and user/auth tests include cross-shop access checks.
- The refresh-cookie configuration is `httpOnly`, `Secure`, and `SameSite=Strict`; credential-bearing login/refresh/logout routes are explicitly excluded from persisted write-response idempotency as documented in `MONGO_DECISIONS.md`.

## Evidence from this run

| Command | Result |
|---|---|
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd test` | 264 tests across 44 file summaries: 253 passed, 0 failed, 11 skipped. The skipped cases are real-Mongo tests in this non-Compose runner. |
| `npm.cmd run build` | Exit 0; existing Vite `__dirname` and large-chunk warnings remain. |
| `npm.cmd --prefix server run test:security` | 9 passed, 0 failed, 0 skipped. |
| `npm.cmd --prefix server run test:catalog` | 9 passed, 0 failed, 0 skipped. |
| `npm.cmd audit --omit=dev` | 0 vulnerabilities reported. |
| `npm.cmd --prefix server audit --omit=dev` | 0 vulnerabilities reported. |
| `docker compose up --no-deps --force-recreate mongo-init` | Exited 0; application indexes initialized. |
| `docker compose run --build --rm api-test` | 11 passed, 0 failed, 0 skipped against the local authenticated Mongo replica set. |
| `docker compose ps --all` | Mongo healthy; mongo-init Exited (0); API healthy; web healthy. |
| `curl.exe --silent --show-error --include -H "Origin: http://localhost:8080" http://localhost:8080/api/health` | HTTP 200, database health response, allowed-origin header, and API/Nginx headers. |
| `curl.exe --silent --show-error --include -H "Origin: https://blocked.example.test" http://localhost:8080/api/health` | HTTP 403 with generic `ORIGIN_NOT_ALLOWED`. |

The API/Nginx headers were checked again after rebuilding `web`; the shared header values appeared once in the proxied API response. The unauthenticated root page returned HTTP 200 with the static Nginx security headers.

## Not tested / remaining risk

- No penetration test, fuzzing campaign, adversarial review, third-party assessment, or production traffic test was run.
- The current web origin and HTTP-only local Compose setup do not establish production CORS, TLS, DNS, reverse-proxy, firewall, or cookie behavior. Production configuration remains unvalidated.
- The route sweep uses the test app/repositories and mostly empty requests; it is not proof that every successful business response under all data/role combinations is safe. Representative cross-shop tests exist, but every resource/identifier combination was not exhaustively enumerated.
- The request-limit behavior was exercised with an injected in-memory store. The Mongo TTL index initializer ran successfully, but concurrent/distributed Mongo counter behavior, failover, TTL deletion timing, and abuse under real traffic were not load-tested.
- `npm audit --omit=dev` checks the current dependency metadata at run time; it does not assess vulnerabilities in application logic or transitive development dependencies.
- Browser/manual module workflows, label/receipt printing, operational monitoring, backup restore, and production deployment remain outstanding.
- Authenticated write idempotency intentionally excludes login, refresh, and logout because replay storage must not retain credential-bearing responses or interfere with token rotation. See `MONGO_DECISIONS.md`.

