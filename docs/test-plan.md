# Test Plan — TikTok LIVE Platform

**Owner Agent**: Copilot (QA, CI/CD & Developer Experience Lead)  
**Depends on**: docs/architecture.md, docs/storage.md, docs/contracts/unified-event.v1.schema.json, docs/fixtures.md, postman/ttlc.postman_collection.json  
**GitHub Issue**: [#6](https://github.com/rainbowkillah/tiktok-live-platform/issues/6)  
**Status**: Draft — Pending Peer Review

---

## Decision Log

- Test framework selection: **Jest** for unit and integration tests (ecosystem standard, compatible with Node.js + TypeScript; configured with `ts-jest`). Vitest may be adopted in Phase 3 if build performance becomes an issue.
- Docker Compose (`docker-compose.test.yml`) provides ephemeral Postgres and Redis instances for integration tests; tests are never run against shared/production infrastructure.
- Schema validation runs as a pre-test CI step using Ajv — this is a hard gate; no other tests proceed if fixtures are invalid.
- Performance and load testing are deferred to Phase 4.
- Newman (Postman CLI) runs the Postman collection as part of CI using the `ci` environment (localhost).
- Coverage thresholds are enforced by Jest (`--coverage --coverageThreshold`) and failure blocks the CI pipeline.
- Failure injection tests use the **fault injection** pattern: start a healthy service, then cut dependencies (Redis, Postgres, external WebSocket) via Docker network disconnects or mock overrides.

## Open Questions

1. Should E2E tests drive the UI directly via Playwright or via API calls only (cheaper, faster)?
2. What is the SLA for Phase 2 integration tests? (Target: < 2 minutes total Docker Compose spin-up + test run)
3. Should unit tests mock the Redis Streams client or use a real Redis instance? (Currently: unit tests mock; integration tests use real Redis)
4. How should we handle TikTok API rate-limiting in future live-connection tests (Phase 3)?

## Validation Checklist

Reviewers should verify:
- [ ] Phase 1 acceptance criteria in §4.1 are achievable with the code scaffold as described
- [ ] All 13 canonical event types are covered by a test scenario
- [ ] CI pipeline steps in §7 map correctly to the scripts in `package.json`
- [ ] Failure injection scenarios in §6 have unambiguous pass/fail criteria
- [ ] Coverage thresholds in §5 are realistic for Phase 1 scope

---

## 1. Scope and Objectives

This test plan covers the quality strategy for all phases of the TikTok LIVE Platform. Testing is organized by phase:

| Phase | Focus | Test Types |
|-------|-------|------------|
| Phase 1 | Contracts, schema, fixtures | Schema validation, static analysis |
| Phase 2 | Ingest → Normalize → Store → Broadcast | Unit, integration, API smoke |
| Phase 3 | Rule engine, overlay, UI | Unit, integration, E2E, snapshot |
| Phase 4 | Performance, reliability, security | Load, chaos, pen-test |

This document primarily specifies Phase 1 and Phase 2 tests, with Phase 3/4 stubs.

---

## 2. Test Categories

### 2.1 Schema Validation (Phase 1)

Validates all fixture JSON files against `unified-event.v1.schema.json` using Ajv (strict mode, `format` validation enabled).

**Tool**: `src/validate-fixtures.js`  
**Command**: `npm run validate-fixtures`  
**Pass criteria**: All 13 fixture files exit with code 0; `PASS` printed for each event type

### 2.2 Unit Tests

Isolated tests for individual modules — no external services required. Dependencies (Redis client, Postgres client, HTTP adapters) are mocked.

**Tool**: Jest + `ts-jest`  
**Command**: `npm test`  
**Location**: `tests/unit/`

Modules to test:

| Module | Test File | Key Assertions |
|--------|-----------|----------------|
| Normalizer (`services/normalizer/`) | `tests/unit/normalizer.test.ts` | Each WebcastEvent type produces a schema-valid UnifiedEvent |
| Rule engine — condition evaluation | `tests/unit/rule-condition.test.ts` | Regex, numeric, boolean condition types |
| Rule engine — template expansion | `tests/unit/rule-template.test.ts` | `{placeholder}` substitution with all fixture types |
| Storage writer — `upsert_event` | `tests/unit/storage-writer.test.ts` | Idempotency: duplicate `event_id` does not throw |
| Event ID generator | `tests/unit/event-id.test.ts` | 64-char hex, deterministic for same (streamId, seqNo) |
| SSE broadcaster | `tests/unit/sse.test.ts` | Emits `data:` lines on Redis XREAD |

### 2.3 Integration Tests

Tests a vertical slice of the system using real (Dockerized) Postgres and Redis. No mocks for infrastructure; business logic services may still be in-process.

**Tool**: Jest + Docker Compose  
**Command**: `npm run test:integration`  
**Location**: `tests/integration/`

Scenarios (Phase 2):

| Scenario | Input | Expected Outcome |
|----------|-------|-----------------|
| **Happy path** | Inject all 13 `session-replay.json` events into Redis `ttlc:raw` | Each event appears in `events` table; `sessions` row created; SSE stream broadcasts all 13 events |
| **Idempotency** | Inject same `session-replay.json` twice | `events` table count unchanged; no 500 errors |
| **Replay trigger** | `POST /sessions/:id/replay` with stored session | Events re-emitted to SSE stream in `seqNo` order |
| **Rules fire** | Inject CHAT matching a rule condition | Action is logged in `actions_log`; overlay payload published to `ttlc:overlay` |

### 2.4 API Smoke Tests (Postman / Newman)

Validates every public API endpoint returns the expected HTTP status, headers, and response shape.

**Tool**: Newman (Postman CLI)  
**Command**: `npm run test:api`  
**Collection**: `postman/ttlc.postman_collection.json`  
**Environment**: `postman/environments/ci.postman_environment.json`  
**Location**: N/A (collection is the test)

See `postman/ttlc.postman_collection.json` for request details and assertions.

### 2.5 End-to-End Tests (Phase 3)

Full user-journey tests that drive the system from an API or browser client through to observable output.

**Tool**: Playwright (UI) or Supertest (API-only)  
**Command**: `npm run test:e2e` *(stub — Phase 3)*  
**Location**: `tests/e2e/`

Planned journeys:
- Viewer joins → creator sees join alert in overlay
- Creator creates alert rule → alert fires on next matching gift
- Operator pauses a session → SSE stream stops; resume restores stream

### 2.6 Performance Tests (Phase 4)

Load and stress tests validating throughput and latency SLAs.

**Tool**: k6 or Artillery  
**Command**: `npm run test:perf` *(stub — Phase 4)*

Planned scenarios:
- 1,000 events/second sustained for 60 seconds on ingest pipeline
- SSE fan-out with 100 concurrent browser clients
- Redis Streams consumer lag < 500 ms at p99

---

## 3. Test Data

All test data comes from the fixture catalog (`docs/fixtures.md`). Tests must never connect to a live TikTok stream.

| Data Set | Location | Usage |
|----------|----------|-------|
| Single-event fixtures | `src/fixtures/*.fixture.json` | Unit test inputs; schema validation |
| Session replay (Phase 2) | `tests/fixtures/session-replay.json` | Integration test input sequence |
| Rule definitions | `tests/fixtures/rules.fixture.json` *(Phase 2)* | Seed rules for integration tests |
| Postman environment — CI | `postman/environments/ci.postman_environment.json` | API smoke tests (`base_url=http://localhost:3000`) |
| Postman environment — local | `postman/environments/local.postman_environment.json` | Developer manual testing |

---

## 4. Acceptance Criteria

### 4.1 Phase 1 Gate ✅

The Phase 1 release is complete when:

1. `npm run validate-fixtures` exits 0 with 13 PASS lines
2. All source files pass TypeScript compilation (`npx tsc --noEmit`)
3. The `docs/` directory contains all required Phase 1 documents: `architecture.md`, `storage.md`, `threat-model.md`, `ui-flows.md`, `fixtures.md`, `test-plan.md`, `contracts/unified-event.v1.schema.json`
4. Each Phase 1 document has been reviewed by at least one peer agent and recorded ✅ or ⚠️ in `docs/reviews.<agent>.md`

### 4.2 Phase 2 Gate

The Phase 2 release is complete when:

1. All Phase 1 gates pass
2. `npm test` passes with ≥ 80% statement coverage
3. `npm run test:integration` passes (all 4 integration scenarios)
4. `npm run test:api` (Newman) returns 0 failures
5. `docker compose up` produces a running system with health check `GET /health → 200 OK`
6. The session replay scenario (§2.3) runs end-to-end in < 30 seconds on CI

### 4.3 Phase 3 Gate *(stub)*

1. All Phase 2 gates pass
2. `npm run test:e2e` passes for all 3 planned journeys
3. Playwright visual snapshots accepted for overlay component

### 4.4 Phase 4 Gate *(stub)*

1. All Phase 3 gates pass
2. Load test: 1,000 events/second for 60 seconds — p99 ingest latency < 200 ms
3. Zero security findings in OWASP ZAP scan (medium+ severity)

---

## 5. Coverage Goals

| Test Type | Target | Enforcement |
|-----------|--------|-------------|
| Schema validation | 100% of fixture types | `validate-fixtures` CI step |
| Unit — statement | ≥ 80% | Jest `--coverageThreshold` |
| Unit — branches | ≥ 75% | Jest `--coverageThreshold` |
| API endpoints | 100% of defined endpoints hit | Newman test assertions |
| Integration scenarios | 4 of 4 pass (Phase 2) | Jest integration suite |

Coverage reports are generated to `coverage/` and uploaded as a CI artifact on each run.

---

## 6. Failure Injection Scenarios

These tests verify the platform's resilience. Each scenario is run as part of the integration test suite in a Docker Compose environment.

### 6.1 Streamer API Unavailable

**Setup**: Start services; block outbound WebSocket connections from the ingest service using Docker network rules or mock override.  
**Action**: Attempt to start a stream session via the ingest service.  
**Expected**:
- Ingest service emits a `DISCONNECTED` event with `willReconnect: true`
- Ingest service retries with exponential backoff (observable in logs)
- No error is surfaced to the SSE API consumer (client receives no events but stays connected)

### 6.2 Redis Unavailable

**Setup**: Start services; stop the Redis container after ingest has connected.  
**Action**: Continue sending events through the ingest pipeline.  
**Expected**:
- Ingest service logs `Redis write error` and begins buffering or dropping events (buffering preferred)
- Storage writer logs reconnection attempts
- SSE clients receive a `retry:` directive and reconnect when Redis recovers
- No events are duplicated in Postgres after Redis recovery

### 6.3 Postgres Unavailable

**Setup**: Start services; stop the Postgres container after normalizer has started.  
**Action**: Continue sending events through the normalizer pipeline.  
**Expected**:
- Storage writer retries with exponential backoff; logs the delay
- Normalizer does not block Redis consumer (buffering in memory up to configurable limit)
- Events are persisted to Postgres after recovery (no loss within buffer window)
- `GET /sessions/:id/events` returns 503 during outage with `Retry-After` header

### 6.4 Malformed Events

**Setup**: Inject a JSON payload with a missing `eventType` field into `ttlc:raw`.  
**Expected**:
- Normalizer logs a validation error with the raw payload
- The event is written to a dead-letter stream (`ttlc:dlq`)
- No crash or unhandled exception in the normalizer service
- The SSE stream continues operating normally

### 6.5 Duplicate Event Injection

**Setup**: Inject the same `event_id` twice with identical payload.  
**Expected**:
- Postgres `events` table contains exactly one row for that `event_id`
- Storage writer logs a deduplication hit but returns success (no error propagated)

---

## 7. CI Pipeline

The GitHub Actions workflow (`/.github/workflows/ci.yml`) enforces the following quality gates on every pull request to `main` and `work` branches:

```
Step 1: Install dependencies
  npm ci

Step 2: TypeScript compile check
  npx tsc --noEmit

Step 3: Schema validation
  npm run validate-fixtures
  ↳ FAIL FAST — all subsequent steps are skipped if this fails

Step 4: Unit tests
  npm test -- --coverage --coverageThreshold='{"global":{"statements":80,"branches":75}}'

Step 5: API smoke tests (requires services to be running)
  docker compose -f docker-compose.test.yml up -d
  npm run test:api
  docker compose -f docker-compose.test.yml down

Step 6: Integration tests
  docker compose -f docker-compose.test.yml up -d
  npm run test:integration
  docker compose -f docker-compose.test.yml down

Step 7: Upload coverage report
  Upload coverage/ as a CI artifact
```

**Branch protection rules** (configured by Copilot as merge authority):
- All CI steps must pass before merge
- At least 1 peer agent review required (`docs/reviews.<agent>.md` updated)
- No force-pushes to `main`

---

## 8. Tooling Summary

| Tool | Version | Purpose |
|------|---------|---------|
| Jest | ^29 | Unit and integration test runner |
| ts-jest | ^29 | TypeScript transform for Jest |
| Ajv | ^8 | JSON Schema validation (fixtures + runtime) |
| ajv-formats | ^2 | `date-time`, `uuid`, `uri` format support |
| Newman | ^6 | Postman collection CI runner |
| Docker Compose | v2 | Ephemeral Postgres + Redis for integration tests |
| Playwright | ^1 *(Phase 3)* | E2E browser automation |
| k6 or Artillery | TBD *(Phase 4)* | Load and stress testing |

---

## 9. Test File Structure

```
tests/
├── unit/
│   ├── normalizer.test.ts
│   ├── rule-condition.test.ts
│   ├── rule-template.test.ts
│   ├── storage-writer.test.ts
│   ├── event-id.test.ts
│   └── sse.test.ts
├── integration/
│   ├── happy-path.test.ts
│   ├── idempotency.test.ts
│   ├── replay.test.ts
│   └── rules-fire.test.ts
├── fixtures/
│   ├── session-replay.json       (Phase 2)
│   └── rules.fixture.json        (Phase 2)
└── e2e/
    ├── viewer-join-alert.test.ts  (Phase 3)
    ├── creator-rule.test.ts       (Phase 3)
    └── session-pause.test.ts      (Phase 3)
```
