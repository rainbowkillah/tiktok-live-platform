# Threat Model — TikTok LIVE Platform

**Owner Agent**: Gemini (AI Agent)
**Depends on**: [docs/architecture.md](architecture.md), [docs/contracts/unified-event.v1.schema.json](contracts/unified-event.v1.schema.json), [docs/storage.md](storage.md)
**GitHub Issue**: [#4](https://github.com/rainbowkillah/tiktok-live-platform/issues/4)
**Status**: Approved

---

## Decision Log

- Adopted the **STRIDE** framework to identify and categorize threats across the pipeline (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege).
- Identified critical assets: streamer tokens (`SESSION_ID`), API keys (`EULER_API_KEY`, `DATABASE_URL`), session UUIDs, event payloads, and user PII.
- Enumerated trust boundaries between external TikTok infrastructure, the ingest layer, internal Redis Streams, internal Postgres storage, the API layer, and the Web UI.
- Decided to implement rate-limiting and abuse prevention at both the ingestion layer (reconnect back-off, DLQ) and the UI/API layer (request rate limits, input validation on rule creation).
- Decided that secrets are never stored in source code and are injected via environment variables or a secret management service (see §4).

---

## Open Questions

1. **Authentication/Authorization model**: What auth mechanism will be used for streamers, moderators, and API clients? Options include session-cookie auth, JWT, or OAuth 2.0. This must be resolved before the API service is production-hardened.
2. **Privacy and GDPR compliance**: **[RESOLVED]** A comprehensive privacy policy has been defined in [docs/privacy-policy.md](privacy-policy.md), establishing strict 1-year data retention for PII tables, automated GDPR erasure scripts, and strong pseudonymization (cryptographic hashing) rules.
3. **Third-party attack surface**: The `tiktok-live-connector` npm package and the Euler Stream API introduce dependency-level attack surfaces. A process for vetting and pinning these dependencies is needed.
4. **Real-time abuse monitoring**: What alerting and automated response mechanisms will be in place for detecting and acting on malicious rule creation, webhook abuse, or DLQ flooding in real time?
5. **Rule engine sandboxing**: JSON Logic conditions reduce code injection risk, but the full sandboxing strategy for `webhook` action targets needs definition (allowlist vs. blocklist of domains).

---

## Validation Checklist

Reviewers should verify:
- [ ] Document includes a high-level data flow diagram with clearly identified trust boundaries and attack surfaces
- [ ] All six STRIDE categories are addressed for each trust boundary
- [ ] Proposed mitigations are concrete and implementable
- [ ] Residual risks are explicitly identified
- [ ] Privacy, retention, and secret handling are addressed per the project's security policies
- [ ] Open questions or tasks for deeper analysis in later phases are listed

---

## 1. Critical Assets

| Asset | Location | Sensitivity |
|-------|----------|-------------|
| `SESSION_ID` (TikTok session cookie) | Ingest service env | **Critical** — grants TikTok account access |
| `EULER_API_KEY` | Ingest service env | **Critical** — grants Euler Stream API access |
| `DATABASE_URL` | All services env | **Critical** — full Postgres access |
| `REDIS_URL` | All services env | **High** — full event bus access |
| Session UUIDs (`sessionId`) | Postgres, Redis, API | **High** — used for replay and audit |
| User PII (`userId`, `uniqueId`, `displayName`, `avatarUrl`) | Postgres `users` table, `event_data` JSONB | **High** — GDPR-regulated |
| Event payloads (`event_data`) | Postgres `events` table, Redis Streams | **Medium** — may contain chat content |
| Rule definitions and action templates | Postgres `rules` table | **Medium** — could be abused for announcement spam or webhook abuse |
| Actions audit log | Postgres `actions_log` table | **Medium** — operational data, potential privacy implications |
| TLS private keys / certificates | Reverse proxy / hosting layer | **High** — in-transit encryption |

---

## 2. Trust Boundaries and Data Flow Diagram

```
═══════════════════════════════════════════════════════════════════════════
  EXTERNAL (Untrusted)
  TikTok LIVE Infrastructure (WebSocket / Euler WS API)
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Raw WebSocket frames (proto-encoded)                               │
  │  Attack surfaces: MITM, protocol drift, malformed frames, TikTok   │
  │  server impersonation                                               │
  └────────────────────────────┬────────────────────────────────────────┘
                               │
  ─────────────── TRUST BOUNDARY B1 (TikTok → Ingest) ───────────────────
                               │
  INTERNAL BACKEND (Trusted services, shared Docker network)
  ┌────────────────────────────▼────────────────────────────────────────┐
  │  [1] INGEST SERVICE                                                 │
  │  Manages TikTokLiveConnection / Euler WS API                        │
  │  Attack surfaces: credential theft (SESSION_ID, EULER_API_KEY),     │
  │  reconnect flooding, malformed payload injection                    │
  └────────────────────────────┬────────────────────────────────────────┘
                               │ Redis Stream: ttlc:raw
  ─────────────── TRUST BOUNDARY B2 (Ingest → Normalizer) ───────────────
                               │
  ┌────────────────────────────▼────────────────────────────────────────┐
  │  [2] NORMALIZER SERVICE                                             │
  │  Attack surfaces: schema injection via malformed raw payloads,      │
  │  DLQ flooding (error amplification), SHA-256 eventId collisions     │
  └────────────────────────────┬────────────────────────────────────────┘
                               │ Redis Stream: ttlc:events
               ┌───────────────┼──────────────────────┐
               ▼               ▼                      ▼
  ┌────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐
  │ [3] STORAGE    │  │  [4] API SERVICE │  │  [5] RULE ENGINE /       │
  │    WRITER      │  │  (REST+SSE+WS)   │  │      FORWARDER           │
  │                │  │                  │  │                          │
  │ Postgres       │  │ Exposed to UI &  │  │ Executes actions;        │
  │ Attack surface:│  │ external clients │  │ POSTs to webhook URLs    │
  │ SQL injection  │  │ Attack surfaces: │  │ Attack surfaces:         │
  │ via event_data │  │ auth bypass,     │  │ SSRF via webhook,        │
  │ JSONB, cred    │  │ XSS, CSRF,       │  │ template injection,      │
  │ compromise     │  │ rate abuse, SSE  │  │ rule privilege abuse     │
  └────────────────┘  │ stream hijack    │  └──────────────────────────┘
                      └────────┬─────────┘
  ─────────────── TRUST BOUNDARY B3 (API → UI/Clients) ──────────────────
                               │ HTTP/HTTPS, SSE, WebSocket
  EXTERNAL (Partially trusted: authenticated UI clients, moderators)
  ┌────────────────────────────▼────────────────────────────────────────┐
  │  [UI] Web App (Streamer & Moderator Views)                          │
  │  Attack surfaces: XSS, CSRF, client-side rule injection,            │
  │  session token theft, clickjacking                                  │
  └─────────────────────────────────────────────────────────────────────┘

  ─────────────── TRUST BOUNDARY B4 (Rule Engine → External Webhooks) ───

  EXTERNAL (Untrusted: webhook destinations)
  ┌─────────────────────────────────────────────────────────────────────┐
  │  Webhook URLs configured in rules                                   │
  │  Attack surfaces: SSRF, response injection, data exfiltration       │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## 3. STRIDE Threat Analysis

### 3.1 Spoofing

| ID | Threat | Trust Boundary | Proposed Mitigation | Residual Risk |
|----|--------|---------------|---------------------|---------------|
| S-01 | Attacker spoofs TikTok WebSocket server (MITM) to inject crafted events | B1 | Enforce TLS certificate validation; pin Euler API endpoint certificate in production; do not disable TLS verification in any environment | Low — TLS effectively prevents MITM on a well-configured host |
| S-02 | Unauthenticated client calls API endpoints (rule creation, replay trigger) | B3 | Implement auth middleware (session-cookie or JWT) on all state-mutating endpoints; reject unauthenticated requests with HTTP 401 | **Open** — auth model not yet decided (Open Question 1) |
| S-03 | Replay request spoofs a different user's session | B3 | Validate that the requesting user owns the session being replayed; enforce ownership checks in `POST /sessions/:id/replay` | Medium until auth model is implemented |
| S-04 | Attacker injects forged events into `ttlc:raw` or `ttlc:events` by accessing Redis directly | B2 | Redis must not be exposed outside the Docker network; use `requirepass` and `bind 127.0.0.1` in all deployments; rotate Redis credentials regularly | Low — network isolation enforces this boundary |

---

### 3.2 Tampering

| ID | Threat | Trust Boundary | Proposed Mitigation | Residual Risk |
|----|--------|---------------|---------------------|---------------|
| T-01 | Malformed or adversarial proto payload corrupts event pipeline | B1 | Normalizer validates all payloads against `unified-event.v1.schema.json` using AJV before publishing to `ttlc:events`; failures are dead-lettered to `ttlc:dlq` | Low — schema validation gate prevents invalid payloads reaching downstream |
| T-02 | Attacker tampers with event payload in transit between services (Redis MITM) | B2 | Encrypt Redis traffic with TLS in cloud deployments (e.g., Upstash TLS); within Docker network, rely on network isolation | Medium in cloud until TLS is enforced on Redis; Low in Docker Compose |
| T-03 | Rule condition (JSON Logic) is crafted to produce unexpected evaluation results | B3 | Validate JSON Logic expressions at rule creation time; reject unsupported operators; add maximum depth/complexity limits | Low — JSON Logic has no side effects; worst case is a false-positive rule trigger |
| T-04 | Attacker modifies stored events in Postgres directly | B3 | Apply Postgres row-level security; the application user must not have UPDATE/DELETE on `events` table; separate admin credentials for GDPR operations | Medium — requires DB credential compromise first |
| T-05 | `event_data` JSONB column used to inject malicious content rendered in the UI | B3/UI | Sanitize all fields rendered to HTML on the client side; use a Content Security Policy (CSP) header; never use `innerHTML` with event content | Medium until CSP and output encoding are implemented |

---

### 3.3 Repudiation

| ID | Threat | Trust Boundary | Proposed Mitigation | Residual Risk |
|----|--------|---------------|---------------------|---------------|
| R-01 | User denies sending a chat message or gift | B1→Storage | Events are stored append-only with `eventId` (SHA-256 dedupe key), `source`, `sessionId`, and `timestamp`; this provides a non-repudiable audit trail | Low — append-only store with deterministic event IDs prevents denial |
| R-02 | Moderator denies executing a rule action (ban, announce) | B3→Storage | All rule executions are logged to `actions_log` with `rule_id`, `event_id`, `rendered_template`, `executed_at`, and `status`; audit log is append-only | Low — `actions_log` provides full accountability |
| R-03 | Admin denies performing a GDPR hard-delete operation | Internal | GDPR erasure operations must be performed through a documented runbook that generates a separate audit record outside the `events` table (e.g., `gdpr_erasures` table or external log) | **Open** — GDPR erasure runbook not yet drafted (Open Question 2) |
| R-04 | Service crashes obscure which events were processed | B2 | Structured JSON logging with `sessionId`, `eventId`, and `seqNo` on every operation; use `XACK` only after side effects complete to enable message redelivery on crash | Low — at-least-once delivery semantics with structured logs |

---

### 3.4 Information Disclosure

| ID | Threat | Trust Boundary | Proposed Mitigation | Residual Risk |
|----|--------|---------------|---------------------|---------------|
| I-01 | `SESSION_ID`, `EULER_API_KEY`, or `DATABASE_URL` leaked to source control | All | `.gitignore` blocks `.env`; secret scanning enabled in CI (GitHub secret scanning + push protection); never log secret values; inject via secret manager in production | Low — requires contributor error AND secret scan bypass |
| I-02 | User PII (`userId`, `uniqueId`, `displayName`, `avatarUrl`) exposed in logs or error messages | B2/B3 | Structured logging must not include raw event payloads at `info` level; PII fields must be masked or omitted at `debug` level in production; use `LOG_LEVEL=info` in production | Medium — requires explicit enforcement in all services |
| I-03 | Error responses from the API expose internal stack traces or DB schema | B3 | In production, return generic error messages to clients; log full errors server-side only; never include `stack` in HTTP error responses except in `development` mode | Medium — implement global error handler with env-aware response serialization |
| I-04 | SSE stream (`/streams/:streamId/events`) accessed without authorization | B3 | Require authentication on SSE endpoint; enforce stream ownership (streamer can only access their own stream's feed); moderators may have broader access per permission model | **Open** — depends on auth model (Open Question 1) |
| I-05 | User PII retained beyond the configured retention period | Storage | 90-day pruning job soft-deletes events and pseudonymizes `users.display_name` and `users.avatar_url` (see storage.md §4.2); configure `EVENT_RETENTION_DAYS` per deployment | Low if pruning job is operational; Medium if job fails silently |
| I-06 | Chat content or user identifiers exposed via `ttlc:dlq` to unauthorized consumers | B2 | DLQ messages contain original payloads; restrict DLQ consumer group (`ops`) to authorized operations tooling; do not expose DLQ contents via the API | Low — requires Redis access |
| I-07 | `avatarUrl` or external image URLs in event data used to exfiltrate client IP addresses | UI | Proxy or sanitize image URLs before rendering in the UI; do not directly render arbitrary `avatarUrl` values from event payloads without a trusted CDN proxy | Medium — requires UI-layer implementation |

---

### 3.5 Denial of Service

| ID | Threat | Trust Boundary | Proposed Mitigation | Residual Risk |
|----|--------|---------------|---------------------|---------------|
| D-01 | TikTok rate-limits or CAPTCHAs the connector, causing reconnect storms | B1 | Exponential back-off with jitter (initial 1 s, max 60 s, multiplier 2×, ±20% jitter); `RECONNECT_MAX_ATTEMPTS` cap; alert on DLQ growth | Medium — TikTok-side controls are outside our control (Risk R-02) |
| D-02 | High event volume (10k+ events/min) degrades Redis Streams | B2 | Cap streams with `XADD ... MAXLEN ~` (soft cap); monitor consumer lag; alert when lag exceeds threshold | Low with MAXLEN configured; Medium if MAXLEN is not set |
| D-03 | DLQ flooded with malformed frames (error amplification) | B2 | Cap `ttlc:dlq` with MAXLEN; alert when DLQ entry rate exceeds threshold; implement circuit breaker in normalizer to pause ingestion if DLQ rate is too high | Medium — deliberate malformed-frame injection could exhaust DLQ capacity |
| D-04 | API endpoint abuse: high-frequency REST requests exhaust API service resources | B3 | Implement per-IP and per-user request rate limiting on all API endpoints (e.g., express-rate-limit or Fastify rate-limit plugin); return HTTP 429 with Retry-After header | Medium until rate limiting is implemented |
| D-05 | SSE connection leak: attacker opens thousands of SSE connections to exhaust server file descriptors | B3 | Enforce maximum concurrent SSE connections per authenticated user; implement connection timeout and heartbeat; reject connections exceeding the limit | Medium — SSE is inherently stateful and connection-intensive |
| D-06 | Postgres storage grows unbounded due to pruning job failure | Storage | Monitor `events` table row count and size; alert when count exceeds threshold; pruning job failure must be observable (structured log, metric, or health-check failure) | Low with monitoring; Medium if pruning runs silently |
| D-07 | Rule engine executes expensive webhook actions in a tight loop | B3/Rule Engine | Debounce rule execution per `(ruleId, userId)` pair within a time window; add per-rule execution rate limit; alert on abnormally high `actions_log` insert rate | Medium — requires rule engine implementation |
| D-08 | Replay session re-injects a very large stored session, flooding `ttlc:raw` | B3 | Implement replay speed control (`?speed=` param); add maximum replay event throughput cap; require authenticated request for replay trigger | Low — replay is an authenticated, deliberate operation |

---

### 3.6 Elevation of Privilege

| ID | Threat | Trust Boundary | Proposed Mitigation | Residual Risk |
|----|--------|---------------|---------------------|---------------|
| E-01 | Unauthenticated user creates, modifies, or deletes rules | B3 | All `POST /rules`, `PUT /rules/:id`, `DELETE /rules/:id` endpoints require authentication; enforce role-based access control (streamer can only manage their own rules; moderators can view but not delete) | **Open** — RBAC model not yet defined (Open Question 1) |
| E-02 | Rule engine executes a `moderate` (ban/timeout) action triggered by an unauthorized user | Rule Engine | `moderate` actions must be gated behind an elevated permission check; log all moderation actions to `actions_log` with the triggering rule and event | **Open** — moderation action authorization pending auth model |
| E-03 | `webhook` rule action used to perform SSRF against internal infrastructure | Rule Engine | Validate webhook URLs against an allowlist of permitted external domains; block private IP ranges (RFC 1918), loopback, and link-local addresses; enforce HTTPS only for webhooks | **High priority** — SSRF must be mitigated before webhook actions are enabled in production |
| E-04 | JSON Logic condition crafted to access properties beyond the event payload | Rule Engine | Enforce strict JSON Logic context: only pass the `UnifiedEvent` object as the data context; never pass `process.env`, `global`, or any other context; validate the logic tree against a schema before evaluation | Low — JSON Logic is data-only; node access requires explicit context injection |
| E-05 | Compromised API service process gains Postgres superuser privileges | Storage | The application's Postgres user must have only the minimum required permissions (`SELECT`, `INSERT`, `UPDATE` on specific tables; no `DROP`, `TRUNCATE`, or DDL); use a separate migration user for schema changes | Low with least-privilege enforcement; Medium if a single DB user is used for all operations |
| E-06 | Attacker exploits template injection in rule `template` field to execute server-side code | Rule Engine | Template rendering must use a strict token-replacement approach (e.g., replace only known `{token}` patterns); never use `eval()` or `Function()` for template rendering; validate template against allowed token list at creation time | Low — strict token replacement has no code execution surface |

---

## 4. Secret Handling

All secrets are classified as radioactive and must be handled as follows:

| Secret | Handling Policy |
|--------|----------------|
| `SESSION_ID` | Never logged; never in source code; never in API responses; injected via `.env` locally and via secret manager in production |
| `EULER_API_KEY` | Same as `SESSION_ID` |
| `DATABASE_URL` | Same as `SESSION_ID`; use connection pooling to minimize exposure surface |
| `REDIS_URL` (if authenticated) | Same as `SESSION_ID` |
| JWT signing key (future) | Rotate on a schedule; never commit; use asymmetric keys (RS256 or ES256) |

**CI/CD**: Use GitHub Actions encrypted secrets for CI pipelines. Never print secrets to logs. Use `::add-mask::` for any value derived from a secret.

**Local development**: `.env` file is blocked by `.gitignore`. The repository must include a `.env.example` with placeholder values and no real secrets.

**Secret rotation**: Establish a rotation schedule and a documented runbook for rotating each secret class without service downtime.

---

## 5. Privacy and Data Retention

This section has been consolidated. Please see [docs/privacy-policy.md](privacy-policy.md) for the full data retention and privacy policy, including details on pseudonymization, PII scrubbing, and automated GDPR right-to-erasure processes.

---

## 6. Third-Party Dependency Threats

| Dependency | Threat | Mitigation |
|-----------|--------|-----------|
| `tiktok-live-connector` (npm) | Malicious update introduces supply chain attack or leaks `SESSION_ID` | Pin to a specific version in `package.json`; review changelog on every update; monitor for GitHub security advisories; consider forking if stability becomes critical (Risk R-01) |
| Euler Stream API | Euler API compromise exposes streamer account credentials or injects malicious events | `EULER_API_KEY` is treated as a radioactive secret; validate all Euler API responses before processing; implement TLS certificate pinning for the Euler endpoint |
| `jsonlogic` / JSON Logic evaluator | Malicious JSON Logic payload causes unexpected behavior or prototype pollution | Use a well-maintained, audited JSON Logic library; pin the version; enforce strict context isolation; fuzz-test rule conditions in CI |
| Postgres (`pg` / `node-postgres`) | SQL injection via user-controlled input | Use parameterized queries exclusively; never interpolate event data into SQL strings; the `event_data` JSONB column is never used in `WHERE` clauses via raw string interpolation |
| Redis client | Command injection via malformed stream keys or field values | Use a maintained Redis client library; do not construct Redis commands from user-controlled input; validate stream names against a known pattern |
| Node.js runtime | Known CVEs in the runtime or its built-in modules | Pin Node.js major version in `Dockerfile`; subscribe to Node.js security releases; update regularly |
| Docker base images | Vulnerabilities in OS packages within containers | Use minimal base images (`node:20-alpine`); run Trivy or Snyk container scanning in CI; never run containers as root |

---

## 7. Rate-Limiting and Abuse Prevention

### 7.1 Ingestion Layer

- Reconnect back-off is enforced in the ingest service (see [architecture.md §3.1](architecture.md#31-ingest-service-ingest)) to prevent TikTok rate-limit triggers.
- `XADD ... MAXLEN ~` caps Redis Streams to prevent memory exhaustion.
- DLQ (`ttlc:dlq`) is also capped to prevent error amplification attacks (D-03).

### 7.2 API Layer

- All state-mutating endpoints (`POST`, `PUT`, `DELETE`) must require authentication (mitigates S-02, E-01).
- Per-IP rate limiting on public endpoints; per-user rate limiting on authenticated endpoints (mitigates D-04).
- Maximum concurrent SSE connections per user (mitigates D-05).
- Request body size limits on all `POST` endpoints (e.g., 64 KB max for rule creation).

### 7.3 Rule Engine

- Execution rate limit per `(ruleId, userId)` pair within a sliding window (mitigates D-07).
- Webhook URL validation against an allowlist and RFC 1918 blocklist (mitigates E-03).
- Template token validation at rule creation time (mitigates E-06).
- All executions logged to `actions_log` for abuse detection (mitigates R-02).

---

## 8. Monitoring and Incident Response

| Signal | Threshold | Response |
|--------|-----------|----------|
| DLQ entry rate (`ttlc:dlq`) | > 10 entries/minute | Alert on-call; investigate normalizer errors; consider pausing ingestion |
| Redis consumer lag (`ttlc:events`) | > 1000 unacked messages | Alert; investigate storage-writer or API consumer health |
| Reconnect attempt count | > 10 in 5 minutes | Alert; possible TikTok rate-limit or CAPTCHA; switch provider or back off |
| API 4xx rate | > 5% of requests in 1 minute | Alert; possible auth bypass attempt or client misconfiguration |
| API 5xx rate | > 1% of requests in 1 minute | Alert; investigate service health |
| `events` table row count | > configurable high-water mark | Alert; verify pruning job is running |
| `actions_log` insert rate | > 100 rows/minute | Alert; possible rule engine abuse loop |
| Secret scanning alert | Any | Immediate rotation of the exposed secret; assess blast radius |

**Incident response**: On a critical alert (secret exposure, SSRF attempt, DLQ flood), follow these steps:
1. Isolate the affected service (stop the Docker container or disable traffic).
2. Rotate any potentially compromised credentials immediately.
3. Preserve logs before any restart.
4. Investigate root cause using structured logs, `actions_log`, and `ttlc:dlq` contents.
5. Document the incident in the decision log.

---

## 9. Risk Register (Threat Model View)

This register cross-references the STRIDE analysis above with the architecture risk register ([architecture.md §7](architecture.md#7-risk-register)).

| ID | STRIDE Category | Severity | Likelihood | Mitigated by |
|----|----------------|----------|------------|-------------|
| S-02 | Spoofing | Critical | Medium | Auth middleware (not yet implemented) |
| T-05 | Tampering | High | Medium | CSP + output encoding (not yet implemented) |
| I-01 | Information Disclosure | Critical | Low | `.gitignore` + CI secret scanning |
| I-02 | Information Disclosure | High | Medium | Structured logging policy |
| I-03 | Information Disclosure | High | Medium | Global error handler (not yet implemented) |
| D-01 | Denial of Service | High | Medium | Exponential back-off + DLQ monitoring |
| D-04 | Denial of Service | High | Medium | API rate limiting (not yet implemented) |
| E-01 | Elevation of Privilege | Critical | Medium | RBAC on rule endpoints (not yet implemented) |
| E-03 | Elevation of Privilege | Critical | Medium | SSRF protection on webhooks (**must implement before production**) |
| E-05 | Elevation of Privilege | High | Low | Least-privilege Postgres user |

> Items marked **not yet implemented** are tracked as open tasks for Phase 2 security hardening.
