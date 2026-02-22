# Decision Log — TikTok LIVE Platform

**Owner Agent**: Claude (Program Lead & Systems Architect)
**Depends on**: All Phase 1 deliverables
**GitHub Issue**: [#250](https://github.com/rainbowkillah/crispy-enigma/issues/250)
**Status**: Living document — updated as decisions are made

---

## Format

Each entry:
- **ID**: `D-NNN`
- **Date**: ISO 8601
- **Context**: Why this decision was needed
- **Decision**: What was chosen
- **Alternatives considered**: Other options evaluated
- **Rationale**: Why this option was chosen
- **Open questions**: Unresolved follow-on issues
- **Decided by**: Agent(s) responsible

---

## Decisions

### D-001: Separate Platform Repository

- **Date**: 2026-02-22
- **Context**: The project needed to determine whether to extend the existing `tiktok-live-connector` npm library or build the platform in a new repository.
- **Decision**: Build the platform in a **new separate repository** (`tiktok-live-platform`) that imports `tiktok-live-connector` as an npm dependency.
- **Alternatives considered**:
  - *Monorepo (extend tiktok-live-connector)*: Would couple the platform to the library's release cycle and scope creep the library's purpose.
  - *Fork tiktok-live-connector*: Would require maintaining a fork, increasing long-term maintenance burden.
- **Rationale**: Clean separation of concerns. The `tiktok-live-connector` library remains a focused, reusable npm package. The platform has its own deployment topology, storage, and UI concerns that don't belong in the library.
- **Open questions**: Should the platform eventually publish its own types package that imports from both repos?
- **Decided by**: Claude (user-confirmed)

---

### D-002: Event Bus — Redis Streams

- **Date**: 2026-02-22
- **Context**: The pipeline needs a fan-out mechanism between the ingest/normalizer services and the downstream consumers (storage-writer, API, rule engine, forwarder). Multiple technology options were evaluated.
- **Decision**: Use **Redis Streams** as the internal event bus.
- **Alternatives considered**:
  - *NATS JetStream*: Excellent performance and consumer groups, but adds a fourth infrastructure dependency (Postgres + Redis + NATS). Overkill for Phase 2 scale.
  - *Postgres LISTEN/NOTIFY*: Zero additional infrastructure, but is polling-based under the hood, lacks persistence beyond session, and has 8KB payload limit on NOTIFY.
  - *RabbitMQ*: Mature but heavyweight; requires additional ops knowledge.
  - *In-process EventEmitter*: Works only for single-process deployments; blocks horizontal scaling.
- **Rationale**: Redis is already required for caching/session management. Redis Streams provide persistence, consumer groups (competing consumers), `XACK`-based at-least-once delivery, configurable `MAXLEN` for bounded memory, and replay-injection support. No extra infrastructure dependency.
- **Open questions**: If scale requires >100k events/min, revisit NATS.
- **Decided by**: Claude

---

### D-003: Primary Storage — PostgreSQL

- **Date**: 2026-02-22
- **Context**: The platform needs durable, queryable storage for events, sessions, users, rules, and audit logs.
- **Decision**: Use **PostgreSQL** as the primary storage backend.
- **Alternatives considered**:
  - *MongoDB*: JSONB-style storage, flexible schema. However, Postgres `JSONB` provides the same flexibility with stronger consistency guarantees and better SQL query support for analytics.
  - *ClickHouse / TimescaleDB*: Excellent for time-series analytics at scale, but adds operational complexity. Deferred to Phase 4 if Postgres query performance becomes a bottleneck.
  - *SQLite*: Too limited for multi-process concurrent writes.
- **Rationale**: Postgres is the industry standard for structured + semi-structured data. The `JSONB` column on `events` gives schema flexibility while SQL provides powerful analytics. Well-supported by all managed cloud providers.
- **Open questions**: If Phase 4 analytics load is too heavy for Postgres, evaluate read-replica or TimescaleDB extension.
- **Decided by**: Claude

---

### D-004: Ingest Provider Strategy — `direct` vs `euler`

- **Date**: 2026-02-22
- **Context**: TikTok LIVE connectivity can be achieved via direct reverse-engineered WebSocket (via `tiktok-live-connector`) or via the Euler Stream API (a stable paid/freemium alternative).
- **Decision**: Support **both providers** via `INGEST_PROVIDER` env var (`direct` | `euler`). Default to `direct` for development; recommend `euler` for production.
- **Alternatives considered**:
  - *Euler only*: Eliminates reverse-engineering fragility but introduces API cost and vendor dependency.
  - *Direct only*: Free, but fragile (TikTok changes break it; captchas; rate limits).
- **Rationale**: Developers should be able to run the stack without an Euler API key. Production deployments benefit from Euler's stability. The abstraction at the ingest layer means the rest of the pipeline is provider-agnostic.
- **Open questions**: Should `euler` become the default once Euler API is free tier confirmed?
- **Decided by**: Claude

---

### D-005: UnifiedEvent `eventId` Dedupe Key

- **Date**: 2026-02-22
- **Context**: Events must be stored idempotently — the same TikTok event arriving twice (e.g., during reconnect overlap) should not create duplicate rows.
- **Decision**: `eventId = SHA-256(streamId + ":" + seqNo + ":" + rawType)` as a hex string (64 chars).
- **Alternatives considered**:
  - *TikTok-provided message ID*: Not consistently present in all message types.
  - *UUID v4*: Random; provides no deduplication.
  - *UUID v5 (namespace hash)*: Semantically equivalent to SHA-256 approach but adds a dependency on UUID library.
- **Rationale**: SHA-256 over the tuple `(streamId, seqNo, rawType)` is deterministic and collision-resistant. `seqNo` is provided by TikTok's WebSocket frame header and is monotonically increasing within a connection. If `seqNo` is not available (lifecycle events), fall back to `SHA-256(streamId + ":" + eventType + ":" + ingestedAt.toISOString())`.
- **Open questions**: Is `seqNo` guaranteed unique within a stream across reconnects? If not, we may need to include `sessionId` in the hash.
- **Decided by**: Claude

---

### D-006: `WebcastSocialMessage` Sub-Type Disambiguation

- **Date**: 2026-02-22
- **Context**: The `tiktok-live-connector` library emits a single `social` event for follows, shares, and subscriptions. The UnifiedEvent schema requires separate canonical types: `FOLLOW`, `SHARE`, `SUBSCRIBE`.
- **Decision**: The normalizer reads the `displayType` field from the `WebcastSocialMessage` proto payload and maps to the appropriate canonical type:
  - Contains `follow` → `FOLLOW`
  - Contains `share` → `SHARE`
  - Contains `subscribe` → `SUBSCRIBE`
  - Unknown → `RAW` (with `rawType = 'WebcastSocialMessage'`)
- **Alternatives considered**:
  - *Keep as a single `SOCIAL` canonical type*: Simpler, but the rule engine and UI need to distinguish these; a GIFT rule should not fire for a FOLLOW.
  - *Inspect the proto type directly in the connector*: Would require modifying `tiktok-live-connector`, violating the separation-of-concerns goal.
- **Rationale**: `displayType` is stable and human-readable. The library already does this disambiguation for `WebcastEvent.FOLLOW` and `WebcastEvent.SHARE` in the custom event layer, confirming it's reliable.
- **Open questions**: Are there other `displayType` values not yet documented?
- **Decided by**: Claude

---

### D-007: Append-Only `events` Table

- **Date**: 2026-02-22
- **Context**: Event stores should preserve history for audit, replay, and analytics. Mutable storage risks accidental data loss.
- **Decision**: The `events` table is **append-only**: no `UPDATE` or `DELETE` from application code. Soft-delete via `archived_at` timestamp. Hard-delete reserved for GDPR erasure (admin runbook operation only).
- **Alternatives considered**:
  - *Allow UPDATE for corrections*: Event correction is a valid use case, but it should be modeled as a new correction event, not an update to the original.
  - *Full delete on retention expiry*: Simpler but loses auditability of what was pruned and when.
- **Rationale**: Append-only ensures an immutable audit trail and enables safe replay. Soft-delete via `archived_at` gives operations visibility. Hard-delete for GDPR compliance is a rare, deliberate, documented operation.
- **Open questions**: Should corrections be modeled as a new `CORRECTION` event type?
- **Decided by**: Claude

---

### D-008: Deployment — Docker Compose First

- **Date**: 2026-02-22
- **Context**: The platform has multiple services (ingest, normalizer, storage-writer, api, ui) plus infrastructure (Postgres, Redis). Team needs a local-first development experience.
- **Decision**: All services must be runnable via a single `docker-compose up` before any cloud deployment target is targeted.
- **Alternatives considered**:
  - *Deploy to cloud from day one*: Fast for single-developer projects, but breaks local development for the multi-agent team.
  - *Kubernetes from day one*: Powerful but enormous ops overhead for Phase 2.
- **Rationale**: Non-negotiable per CLAUDE.md §3. Docker Compose ensures every developer has an identical, reproducible stack. Cloud targets (Cloudflare/Vercel/Railway) are added in Phase 4.
- **Open questions**: None.
- **Decided by**: Claude (non-negotiable from CLAUDE.md)

---

### D-009: Schema-First Development Gate

- **Date**: 2026-02-22
- **Context**: Multiple services depend on the UnifiedEvent schema. If the schema is undefined when implementation starts, services will make incompatible assumptions.
- **Decision**: `unified-event.v1.schema.json` and `storage.md` must be **approved by all agents** (or at least not vetoed) before the normalizer or storage-writer are implemented.
- **Alternatives considered**:
  - *Define schema incrementally as implementation proceeds*: Faster initial velocity but high risk of breaking changes.
- **Rationale**: Non-negotiable per CLAUDE.md §3. Schema-first prevents costly rework and ensures the event contract is stable before code depends on it.
- **Open questions**: None.
- **Decided by**: Claude (non-negotiable from CLAUDE.md)

---

### D-010: `RAW` Passthrough for Unmapped Event Types

- **Date**: 2026-02-22
- **Context**: `tiktok-live-connector` exposes ~30 event types. Only ~10 are mapped to canonical UnifiedEvent types in v1. The rest would be silently dropped if not handled.
- **Decision**: Unmapped event types are passed through as `eventType: "RAW"` with `payload.rawType` preserving the original type name and `payload.data` containing the raw decoded object.
- **Alternatives considered**:
  - *Drop unmapped events*: Simplest, but loses data that may be useful later.
  - *Fail the normalizer on unknown types*: Too strict; would break on TikTok protocol additions.
  - *Map everything to specific types*: Premature; most event types have no immediate consumer.
- **Rationale**: No data loss. RAW events are stored and queryable. As the schema matures, RAW types can be promoted to canonical types in later schema versions. The `rawType` field enables filtering.
- **Open questions**: Should the rule engine support matching on `RAW` events by `rawType`?
- **Decided by**: Claude

---

## Review Status

| Decision | Author | Reviewer | Status |
|----------|--------|----------|--------|
| D-001 | Claude | — | ⏳ Pending review |
| D-002 | Claude | — | ⏳ Pending review |
| D-003 | Claude | — | ⏳ Pending review |
| D-004 | Claude | — | ⏳ Pending review |
| D-005 | Claude | — | ⏳ Pending review |
| D-006 | Claude | — | ⏳ Pending review |
| D-007 | Claude | — | ⏳ Pending review |
| D-008 | Claude | — | ⏳ Pending review |
| D-009 | Claude | — | ⏳ Pending review |
| D-010 | Claude | — | ⏳ Pending review |
