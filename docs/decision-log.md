# Decision Log - TikTok LIVE Platform

**Owner Agent**: Claude (Program Lead & Systems Architect)
**Depends on**: `docs/architecture.md`, `docs/contracts/unified-event.v1.schema.json`, `src/types/unified-event.ts`, `docs/storage.md`, `docs/threat-model.md`, `docs/ui-flows.md`, `docs/test-plan.md`, `postman/collections/ttlc.postman_collection.json`, `docs/fixtures.md`
**GitHub Issue**: [#10](https://github.com/rainbowkillah/tiktok-live-platform/issues/10)
**Status**: Living document - updated when decisions are accepted, amended, or reversed

---

## Decision Record Structure

Every decision entry must include:
- **ID**: `D-NNN` (sequential)
- **Date**: ISO 8601 date
- **Status**: `Proposed`, `Accepted`, `Superseded`, or `Reversed`
- **Context**: why this decision was required
- **Decision**: what was chosen
- **Alternatives considered**: meaningful options evaluated
- **Rationale**: why this option was selected
- **Consequences**: expected impact, constraints, and follow-on work
- **Open questions**: unresolved follow-up items (or `None`)
- **Decided by**: agent(s) and/or user
- **Related**: links to repository issues and supporting docs

## Update Ownership and Workflow

- The author of a material architecture/product decision is responsible for adding or updating an entry in this file in the same PR.
- The owning agent (Claude) reviews for completeness and consistency.
- Contributors from other agents are recorded in **Decided by** when applicable.
- Dissenting opinions are recorded in **Alternatives considered** and, if unresolved, carried into **Open questions**.

## Amendments and Reversals

- Do not rewrite history for accepted decisions.
- To amend a decision, create a new entry with a new ID and add `Supersedes: D-XYZ` in the **Decision** section.
- To reverse a decision, create a new entry with a new ID and add `Reverses: D-XYZ` in the **Decision** section.
- Update the prior entry's **Status** to `Superseded` or `Reversed` and link the replacing record under **Related**.

## Entry Template

```md
### D-0NN: Short Title

- **Date**: YYYY-MM-DD
- **Status**: Accepted
- **Context**:
- **Decision**:
- **Alternatives considered**:
- **Rationale**:
- **Consequences**:
- **Open questions**:
- **Decided by**:
- **Related**:
```

---

## Decisions

### D-001: Separate Platform Repository

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: Determine whether to extend `tiktok-live-connector` directly or build this platform as a separate system.
- **Decision**: Build `tiktok-live-platform` as a separate repository and consume `tiktok-live-connector` as an npm dependency.
- **Alternatives considered**:
  - Extend connector in a monorepo.
  - Maintain a long-lived fork of connector.
- **Rationale**: Keeps connector scope focused while allowing platform-specific architecture, operations, and release cadence.
- **Consequences**:
  - Requires explicit versioning/integration contracts between repos.
  - Avoids coupling platform release velocity to connector internals.
- **Open questions**: Should a shared cross-repo types package be published later?
- **Decided by**: Claude (user-confirmed)
- **Related**: [Issue #1](https://github.com/rainbowkillah/tiktok-live-platform/issues/1), [`docs/architecture.md`](./architecture.md)

### D-002: Event Bus - Redis Streams

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: Need durable internal fan-out from ingest/normalizer to storage, API, rule engine, and forwarder.
- **Decision**: Use Redis Streams as the internal event bus.
- **Alternatives considered**:
  - NATS JetStream.
  - PostgreSQL LISTEN/NOTIFY.
  - RabbitMQ.
  - In-process event emitter.
- **Rationale**: Redis already exists in the stack and Streams provide persistence plus consumer-group delivery.
- **Consequences**:
  - Introduces stream retention and dead-letter management requirements.
  - Preserves replay-friendly at-least-once semantics for downstream services.
- **Open questions**: Re-evaluate NATS if sustained scale exceeds Redis Streams limits.
- **Decided by**: Claude
- **Related**: [Issue #1](https://github.com/rainbowkillah/tiktok-live-platform/issues/1), [`docs/architecture.md`](./architecture.md), [`docs/storage.md`](./storage.md)

### D-003: Primary Storage - PostgreSQL

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: Need durable event/session/rule storage with strong querying and operational maturity.
- **Decision**: Use PostgreSQL as primary storage.
- **Alternatives considered**:
  - MongoDB.
  - ClickHouse/TimescaleDB (deferred).
  - SQLite.
- **Rationale**: PostgreSQL supports relational + JSONB needs with strong consistency and broad managed-service support.
- **Consequences**:
  - Schema and indexing discipline are required for long-term performance.
  - Time-series scale-out decisions are deferred to later phases.
- **Open questions**: Trigger criteria for moving heavy analytics workloads off primary Postgres.
- **Decided by**: Claude
- **Related**: [Issue #3](https://github.com/rainbowkillah/tiktok-live-platform/issues/3), [`docs/storage.md`](./storage.md)

### D-004: Ingest Provider Strategy - `direct` and `euler`

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: TikTok ingest reliability differs between direct connector mode and Euler API mode.
- **Decision**: Support `INGEST_PROVIDER=direct|euler`; default to `direct` for local development.
- **Alternatives considered**:
  - Euler only.
  - Direct only.
- **Rationale**: Preserves local developer accessibility while allowing production stability via Euler.
- **Consequences**:
  - Requires provider abstraction and cross-provider regression testing.
  - Operational runbooks must include provider-specific failure handling.
- **Open questions**: Whether `euler` should become the future production default.
- **Decided by**: Claude
- **Related**: [Issue #1](https://github.com/rainbowkillah/tiktok-live-platform/issues/1), [`docs/architecture.md`](./architecture.md), [`docs/test-plan.md`](./test-plan.md)

### D-005: UnifiedEvent `eventId` Dedupe Key

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: Event ingestion/replay paths require idempotent writes and deterministic dedupe.
- **Decision**: `eventId = SHA-256(streamId + ':' + sessionId + ':' + seqNo + ':' + rawType)` — `sessionId` is mandatory in the hash input.
- **Alternatives considered**:
  - TikTok-native message IDs.
  - Random UUID v4.
  - UUID v5 namespace hashing.
  - `SHA-256(streamId + ':' + seqNo + ':' + rawType)` without `sessionId` — **rejected** because replay sessions reuse the same (streamId, seqNo, rawType) tuples, producing hash collisions that would silently drop replay events via `ON CONFLICT DO NOTHING`.
- **Rationale**: Including `sessionId` ensures each replay or reconnect session produces globally unique event IDs, preserving idempotent storage semantics across both live and replay paths.
- **Consequences**:
  - Normalizer must consistently supply `sessionId`, `seqNo`, and `rawType`.
  - Storage `ON CONFLICT DO NOTHING` on `event_id` correctly dedupes within a session without colliding across sessions.
- **Open questions**: None — `sessionId` inclusion resolved by cross-checking against `unified-event.v1.schema.json` and `storage.md`.
- **Decided by**: Claude
- **Related**: [Issue #2](https://github.com/rainbowkillah/tiktok-live-platform/issues/2), [Issue #3](https://github.com/rainbowkillah/tiktok-live-platform/issues/3), [Issue #9](https://github.com/rainbowkillah/tiktok-live-platform/issues/9), [`docs/contracts/unified-event.v1.schema.json`](./contracts/unified-event.v1.schema.json)

### D-006: `WebcastSocialMessage` Sub-Type Disambiguation

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: Connector emits a shared social event type, while platform contracts require canonical `FOLLOW`, `SHARE`, and `SUBSCRIBE`.
- **Decision**: Parse `displayType`; map follow/share/subscribe variants to canonical event types, fallback to `RAW` on unknown values.
- **Alternatives considered**:
  - Keep single `SOCIAL` canonical event.
  - Patch connector internals.
- **Rationale**: Preserves rule/UI clarity without coupling platform to connector implementation details.
- **Consequences**:
  - Mapping logic must be maintained as new `displayType` variants appear.
  - Unknown values are retained safely via RAW events.
- **Open questions**: Enumerate additional `displayType` values from live capture fixtures.
- **Decided by**: Claude
- **Related**: [Issue #2](https://github.com/rainbowkillah/tiktok-live-platform/issues/2), [Issue #8](https://github.com/rainbowkillah/tiktok-live-platform/issues/8), [`docs/contracts/unified-event.v1.schema.json`](./contracts/unified-event.v1.schema.json)

### D-007: Append-Only `events` Table

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: Replay, auditability, and forensic workflows require immutable event history.
- **Decision**: Keep `events` append-only from application code; use soft archive fields and narrowly scoped GDPR erasure workflows.
- **Alternatives considered**:
  - Application-level mutable updates.
  - Hard-delete retention routines.
- **Rationale**: Immutability reduces silent data loss/regression risk and supports reliable replay semantics.
- **Consequences**:
  - Correction patterns must be modeled as new events, not in-place edits.
  - Requires explicit retention/archival policy operations.
- **Open questions**: Whether a first-class correction event type is needed later.
- **Decided by**: Claude
- **Related**: [Issue #3](https://github.com/rainbowkillah/tiktok-live-platform/issues/3), [Issue #4](https://github.com/rainbowkillah/tiktok-live-platform/issues/4), [`docs/storage.md`](./storage.md)

### D-008: Deployment Baseline - Docker Compose First

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: Multi-service architecture needs reproducible local orchestration before cloud-target specialization.
- **Decision**: Require a complete local stack runnable via `docker-compose up` before prioritizing cloud deployment targets.
- **Alternatives considered**:
  - Cloud-first deployment path.
  - Kubernetes-first setup.
- **Rationale**: Local reproducibility is lower-friction for contributors and supports deterministic testing/debugging.
- **Consequences**:
  - Initial effort favors local developer ergonomics over cloud optimizations.
  - Service definitions must remain environment-portable.
- **Open questions**: None.
- **Decided by**: Claude
- **Related**: [Issue #1](https://github.com/rainbowkillah/tiktok-live-platform/issues/1), [`docs/architecture.md`](./architecture.md), [`docs/test-plan.md`](./test-plan.md)

### D-009: Schema-First Development Gate

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: Parallel implementation across services risks contract drift without an approved schema baseline.
- **Decision**: Require schema and storage contract approval before implementation of dependent services.
- **Alternatives considered**:
  - Evolve schema during service implementation.
- **Rationale**: Prevents incompatible assumptions and reduces expensive refactoring.
- **Consequences**:
  - Frontloads design review effort.
  - Improves integration reliability across ingest, storage, API, and UI.
- **Open questions**: None.
- **Decided by**: Claude
- **Related**: [Issue #2](https://github.com/rainbowkillah/tiktok-live-platform/issues/2), [Issue #3](https://github.com/rainbowkillah/tiktok-live-platform/issues/3), [Issue #9](https://github.com/rainbowkillah/tiktok-live-platform/issues/9)

### D-010: `RAW` Passthrough for Unmapped Event Types

- **Date**: 2026-02-22
- **Status**: Accepted
- **Context**: Connector exposes many events beyond v1 canonical mappings; dropping them would lose potentially valuable data.
- **Decision**: Normalize unmapped messages as `eventType: RAW` with `payload.rawType` and `payload.data` preserved.
- **Alternatives considered**:
  - Drop unknown events.
  - Fail normalization on unknown events.
  - Force premature canonicalization.
- **Rationale**: Preserves data fidelity while allowing incremental schema evolution.
- **Consequences**:
  - Downstream consumers must handle RAW events safely.
  - Future schema versions can promote commonly observed RAW types.
- **Open questions**: Should rule-engine matching on `payload.rawType` be first-class in v2?
- **Decided by**: Claude
- **Related**: [Issue #2](https://github.com/rainbowkillah/tiktok-live-platform/issues/2), [Issue #8](https://github.com/rainbowkillah/tiktok-live-platform/issues/8), [`docs/fixtures.md`](./fixtures.md)

### D-011: Pseudonymization Strategy — HMAC-SHA256 with Server Secret

- **Date**: 2026-02-23
- **Status**: Accepted
- **Context**: Two Phase 1 documents left the pseudonymization algorithm undefined. `docs/storage.md §4.2` stated that `tiktok_user_id` and `unique_id` are "replaced with a cryptographic hash" but did not specify the hash function, whether a secret key is used, or how `events.user_id` references are kept consistent. Gemini's review on Issues #2 and #3 flagged that storing bare TikTok user IDs after a retention period may not constitute GDPR-compliant pseudonymization if the identifiers remain reversible. Three options were evaluated (Issue #22).
- **Decision**: Use **HMAC-SHA256 with a deployment-specific secret** (`PSEUDONYMIZATION_SECRET` env var) to pseudonymize identifier fields:
  - `users.tiktok_user_id` → `encode(hmac(tiktok_user_id, $PSEUDONYMIZATION_SECRET, 'sha256'), 'hex')`
  - `users.unique_id` → `encode(hmac(unique_id, $PSEUDONYMIZATION_SECRET, 'sha256'), 'hex')`
  - `users.display_name` → `NULL`
  - `users.avatar_url` → `NULL`
  - `events.user_id` (matching old `tiktok_user_id`) → updated to new HMAC-SHA256 value in the same transaction
  - `events.event_data` PII fields (`displayName`, `avatarUrl`) → scrubbed to `null` by `gdpr-erasure.ts`
  - Requires `pgcrypto` extension: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`
- **Alternatives considered**:
  - **Option A-bare (SHA-256 without secret)**: Simpler (no secret management). Rejected because TikTok user IDs are sequential numeric strings — a full rainbow table of the ID space is computationally feasible, making bare SHA-256 reversible in practice. Does not constitute robust pseudonymization under GDPR recital 26.
  - **Option B (random token + mapping table)**: Maximally privacy-preserving; re-identification only possible by admins with mapping table access. Rejected for Phase 2: requires a new table, migration, and significant complexity in the pruning job and erasure script. May be revisited if a statutory right-to-re-identification requirement arises.
  - **Option C (null all identifier fields)**: Simplest implementation. Rejected because it destroys per-user event counts (`events.user_id`) and makes it impossible to correlate replayed sessions with the originating user, breaking audit integrity.
- **Rationale**: HMAC-SHA256 with a server secret is deterministic (same user always produces the same pseudonym across the `users` and `events` tables without a secondary lookup), resists rainbow table attacks for enumerable TikTok user IDs, and integrates cleanly with the existing env-var secret pattern already used for `DATABASE_URL` and `EULER_API_KEY`. If the secret is intentionally rotated or deleted, re-identification becomes computationally infeasible — satisfying GDPR right-to-erasure by rendering previously stored hashes unresolvable. Identifier fields (`tiktok_user_id`, `unique_id`) are HMAC'd; display fields (`display_name`, `avatar_url`) are nulled because they carry no relational integrity function.
- **Consequences**:
  - `PSEUDONYMIZATION_SECRET` must be added to `.env.example`, deployment docs, and the secret manager checklist.
  - `docs/storage.md §4.1 Step 6` SQL updated from `digest()` to `hmac()`.
  - `scripts/gdpr-erasure.ts` must use HMAC-SHA256 (same algorithm) when pseudonymizing on-demand to keep `users` and `events` tables consistent.
  - Secret rotation requires re-hashing all already-pseudonymized rows (or accepting that old pseudonyms can no longer be correlated with new ones) — documented as a known operational constraint.
  - `pgcrypto` extension dependency is now mandatory for both the pruning job and the erasure script.
- **Open questions**:
  - Should secret rotation tooling (re-pseudonymize all rows atomically) be scoped for Phase 3?
  - Should `PSEUDONYMIZATION_SECRET` be length-validated at startup (minimum 32 bytes recommended for HMAC-SHA256)?
- **Decided by**: Claude (Program Lead & Systems Architect)
- **Related**: [Issue #22](https://github.com/rainbowkillah/tiktok-live-platform/issues/22), [Issue #3](https://github.com/rainbowkillah/tiktok-live-platform/issues/3), [Issue #21](https://github.com/rainbowkillah/tiktok-live-platform/issues/21), [`docs/storage.md §4.1`](./storage.md), [`docs/storage.md §4.2`](./storage.md), [`docs/threat-model.md`](./threat-model.md)

---

## Review Status

| Decision | Author | Reviewer | Status |
|----------|--------|----------|--------|
| D-001 | Claude | Pending | Accepted |
| D-002 | Claude | Pending | Accepted |
| D-003 | Claude | Pending | Accepted |
| D-004 | Claude | Pending | Accepted |
| D-005 | Claude | Pending | Accepted |
| D-006 | Claude | Pending | Accepted |
| D-007 | Claude | Pending | Accepted |
| D-008 | Claude | Pending | Accepted |
| D-009 | Claude | Pending | Accepted |
| D-010 | Claude | Pending | Accepted |
| D-011 | Claude | Pending | Accepted |
