# Storage Design — TikTok LIVE Platform

**Owner Agent**: Claude (Program Lead & Systems Architect)
**Depends on**: [docs/architecture.md](architecture.md), [docs/contracts/unified-event.v1.schema.json](contracts/unified-event.v1.schema.json)
**GitHub Issue**: [#243](https://github.com/rainbowkillah/crispy-enigma/issues/243)
**Status**: Draft — Pending peer review

---

## Decision Log

See [decision-log.md](decision-log.md) for all storage choices, alternatives considered, and rationale.

## Open Questions

1. Should `events` use Postgres table partitioning by `session_id` or `timestamp` for performance at scale?
2. Is a separate `aggregates` table worth the added complexity for Phase 2, or is it deferred to Phase 4?
3. Should `users` table pseudonymize data after the retention period, or hard-delete?

## Validation Checklist

Reviewers should verify:
- [ ] All 6 core tables are defined with column types, constraints, and indexes
- [ ] `events` is append-only (no UPDATE/DELETE policy is explicit)
- [ ] Replayability path is described end-to-end
- [ ] Retention policy covers TTL, pruning mechanism, and privacy implications
- [ ] Index strategy covers expected query patterns (live feed, history, per-user, per-type)
- [ ] `rules` and `actions_log` tables support the rule engine contract

---

## 1. Technology

**Primary store**: PostgreSQL 16+

- **Local (Phase 2)**: Dockerized Postgres (`postgres:16-alpine`)
- **Cloud (Phase 4+)**: Neon, Supabase, or Railway managed Postgres

**Redis** (event bus, not primary store — see [architecture.md](architecture.md)):
- Streams `ttlc:raw` and `ttlc:events` are ephemeral (capped with `MAXLEN`)
- Redis is not the source of truth; Postgres is

---

## 2. Schema

### 2.1 `streams` — TikTok Live Streams

```sql
CREATE TABLE streams (
    id           TEXT        PRIMARY KEY,          -- TikTok room ID (numeric string)
    unique_id    TEXT        NOT NULL,             -- TikTok @username of the streamer
    title        TEXT,                             -- Stream title at time of connect
    started_at   TIMESTAMPTZ,                      -- When the stream started (TikTok-reported)
    ended_at     TIMESTAMPTZ,                      -- When the stream ended (null if ongoing)
    metadata     JSONB       NOT NULL DEFAULT '{}', -- Raw room info from TikTok API
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_streams_unique_id ON streams(unique_id);
CREATE INDEX idx_streams_started_at ON streams(started_at DESC);
```

**Notes:**
- `id` is the TikTok room ID — stable for the lifetime of a stream
- `metadata` stores the raw `RoomInfo` JSON from `tiktok-live-connector` for debugging

---

### 2.2 `sessions` — Connection Sessions

```sql
CREATE TYPE session_type AS ENUM ('live', 'replay');

CREATE TABLE sessions (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id    TEXT        NOT NULL REFERENCES streams(id),
    type         session_type NOT NULL DEFAULT 'live',
    provider     TEXT        NOT NULL DEFAULT 'direct', -- 'direct' or 'euler'
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at     TIMESTAMPTZ,                           -- null if session is active
    meta         JSONB       NOT NULL DEFAULT '{}'      -- e.g., { "replayedFrom": "<source_session_id>" }
);

CREATE INDEX idx_sessions_stream_id ON sessions(stream_id);
CREATE INDEX idx_sessions_type ON sessions(type);
CREATE INDEX idx_sessions_created_at ON sessions(created_at DESC);
```

**Notes:**
- One stream may have many sessions (reconnects, replays)
- `type='replay'` sessions are created by the replay subsystem
- `meta.replayedFrom` links a replay session back to its source session

---

### 2.3 `events` — Append-Only Event Store (Core Table)

```sql
CREATE TYPE event_source AS ENUM ('live', 'replay');

CREATE TABLE events (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id       TEXT        NOT NULL UNIQUE,    -- SHA-256 dedupe key from UnifiedEvent
    session_id     UUID        NOT NULL REFERENCES sessions(id),
    stream_id      TEXT        NOT NULL REFERENCES streams(id),
    event_type     TEXT        NOT NULL,           -- CHAT, GIFT, LIKE, etc.
    trigger_id     INTEGER     NOT NULL,           -- Numeric trigger mapping from UnifiedEvent
    schema_version TEXT        NOT NULL DEFAULT '1',
    user_id        TEXT,                           -- TikTok user ID (nullable: lifecycle events have no user)
    raw_type       TEXT,                           -- Original proto/event type when event_type='RAW'
    event_data     JSONB       NOT NULL,           -- Full UnifiedEvent JSON
    source         event_source NOT NULL DEFAULT 'live',
    seq_no         BIGINT      NOT NULL DEFAULT 0,
    timestamp      TIMESTAMPTZ NOT NULL,           -- Event time (TikTok-reported)
    ingested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at    TIMESTAMPTZ                     -- Soft-delete / retention: set by pruning job
);

-- Primary query patterns
CREATE INDEX idx_events_session_timestamp  ON events(session_id, timestamp DESC);
CREATE INDEX idx_events_stream_timestamp   ON events(stream_id, timestamp DESC);
CREATE INDEX idx_events_type_timestamp     ON events(event_type, timestamp DESC);
CREATE INDEX idx_events_trigger_timestamp  ON events(trigger_id, timestamp DESC);
CREATE INDEX idx_events_user_timestamp     ON events(user_id, timestamp DESC) WHERE user_id IS NOT NULL;
CREATE INDEX idx_events_raw_type_timestamp ON events(raw_type, timestamp DESC) WHERE raw_type IS NOT NULL;
CREATE INDEX idx_events_archived           ON events(archived_at) WHERE archived_at IS NOT NULL;

-- JSONB indexes for common filter patterns
CREATE INDEX idx_events_data_gin           ON events USING GIN (event_data);
```

**Append-only policy:**
- `events` has **no** `UPDATE` or `DELETE` operations from application code
- Retention pruning sets `archived_at` (soft delete) — rows are excluded from queries via `WHERE archived_at IS NULL`
- Hard deletion (GDPR right-to-erasure) can only be performed via a dedicated admin operation documented in the runbook
- A `RULE` or trigger that blocks UPDATE/DELETE can be added in Phase 4 hardening

**Columns:**
- `event_id` — the SHA-256 dedupe key from UnifiedEvent (computed by normalizer). Unique constraint enables idempotent inserts via `ON CONFLICT (event_id) DO NOTHING`
- `event_data` — the full UnifiedEvent JSON blob. This is the source of truth; other columns are denormalized for query performance
- `seq_no` — TikTok sequence number from the WebSocket frame
- `trigger_id` — numeric trigger mapping aligned to `UnifiedEvent.triggerId` for fast rule filtering and dispatch analytics
- `raw_type` — the unmapped proto/event type (populated when `event_type='RAW'`) for fast diagnostics and analytics

---

### 2.4 `users` — Known TikTok Users

```sql
CREATE TABLE users (
    tiktok_user_id TEXT        PRIMARY KEY,        -- TikTok numeric user ID
    unique_id      TEXT        NOT NULL,            -- @username (may change)
    display_name   TEXT,                            -- Display name (may change)
    avatar_url     TEXT,                            -- Profile picture URL
    first_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_count    BIGINT      NOT NULL DEFAULT 0,  -- Denormalized counter (updated on upsert)
    meta           JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_users_unique_id   ON users(unique_id);
CREATE INDEX idx_users_last_seen   ON users(last_seen DESC);
```

**Upsert strategy:**
```sql
INSERT INTO users (tiktok_user_id, unique_id, display_name, avatar_url)
VALUES ($1, $2, $3, $4)
ON CONFLICT (tiktok_user_id) DO UPDATE
    SET unique_id    = EXCLUDED.unique_id,
        display_name = EXCLUDED.display_name,
        avatar_url   = EXCLUDED.avatar_url,
        last_seen    = NOW(),
        event_count  = users.event_count + 1;
```

---

### 2.5 `rules` — Rule Engine Configuration

```sql
CREATE TABLE rules (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id   TEXT        REFERENCES streams(id),  -- null = global rule
    name        TEXT        NOT NULL,
    description TEXT,
    event_type  TEXT        NOT NULL,                -- Which eventType to match
    condition   JSONB       NOT NULL DEFAULT '{}',   -- JSON Logic condition expression
    action      JSONB       NOT NULL,                -- { type: 'announce'|'moderate'|'webhook'|'log', template: '...' }
    enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
    priority    INTEGER     NOT NULL DEFAULT 0,      -- Higher = evaluated first
    created_by  TEXT,                                -- User/agent that created the rule
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rules_stream_enabled ON rules(stream_id, enabled) WHERE enabled = TRUE;
CREATE INDEX idx_rules_event_type     ON rules(event_type, enabled) WHERE enabled = TRUE;
```

**Condition format** (JSON Logic):
```json
{ ">=": [{ "var": "payload.coins" }, 1000] }
```

**Action format:**
```json
{
  "type": "announce",
  "template": "🎁 {displayName} sent {giftCount}x {giftName} worth {coins} coins!"
}
```

---

### 2.6 `actions_log` — Rule Execution Audit Log

```sql
CREATE TYPE action_status AS ENUM ('success', 'failed', 'skipped');

CREATE TABLE actions_log (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id           UUID        NOT NULL REFERENCES rules(id),
    event_id          TEXT        NOT NULL,           -- References events.event_id
    stream_id         TEXT        REFERENCES streams(id), -- denormalized for per-stream audits
    session_id        UUID        REFERENCES sessions(id), -- denormalized for replay/session audits
    rendered_template TEXT,                           -- The template after placeholder substitution
    executed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status            action_status NOT NULL,
    error             TEXT,                           -- Error message if status='failed'
    duration_ms       INTEGER,                        -- Execution time in ms
    meta              JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_actions_log_rule_id    ON actions_log(rule_id, executed_at DESC);
CREATE INDEX idx_actions_log_event_id   ON actions_log(event_id);
CREATE INDEX idx_actions_log_stream_id  ON actions_log(stream_id, executed_at DESC);
CREATE INDEX idx_actions_log_session_id ON actions_log(session_id, executed_at DESC);
CREATE INDEX idx_actions_log_status     ON actions_log(status, executed_at DESC);
```

---

## 3. Replayability

### 3.1 Design

A **replay session** is a new session (`type='replay'`) that re-injects stored events back through the pipeline as if they were live.

```
Postgres (stored events)
    │
    │  SELECT * FROM events WHERE session_id = $source_id ORDER BY seq_no ASC
    ▼
Ingest Service (--replay-session <id> flag)
    │  publishes to Redis Stream ttlc:raw
    │  with source='replay', sessionId=<new_replay_session_id>
    ▼
Normalizer → Storage Writer → API → UI
```

### 3.2 Replay Procedure

1. Client calls `POST /sessions/:sourceSessionId/replay`
2. API creates a new session record: `INSERT INTO sessions (stream_id, type='replay', meta={replayedFrom: sourceSessionId})`
3. API returns new `replaySessionId`
4. Ingest service (or a dedicated replay worker) reads events from `events WHERE session_id = :sourceSessionId ORDER BY seq_no ASC`
5. For each stored event, publishes the raw `event_data` to `ttlc:raw` with overridden `sessionId = replaySessionId` and `source = 'replay'`
6. Normalizer, storage-writer, and API process the replay events normally
7. Rule engine processes replay events (configurable: rules can opt out of replay evaluation via `meta.skipReplay`)

### 3.3 Replay Speed

- Default: as-fast-as-possible (no throttling)
- Optional: `?speed=1.0` query param replays at real-time speed using original timestamps

---

## 4. Data Retention Policy

| Table | Default Retention | Configurable via |
|-------|------------------|-----------------|
| `events` | 90 days | `EVENT_RETENTION_DAYS` env var |
| `actions_log` | 90 days | `ACTIONS_LOG_RETENTION_DAYS` env var |
| `streams` | Indefinite | Manual admin only |
| `sessions` | Indefinite | Manual admin only |
| `users` | Indefinite | Manual admin only (GDPR erasure on request) |
| `rules` | Indefinite | Manual admin only |

### 4.1 Pruning Job

A scheduled job (cron or pg_cron) runs daily:

```sql
-- Soft-delete expired events
UPDATE events
SET archived_at = NOW()
WHERE timestamp < NOW() - INTERVAL '90 days'
  AND archived_at IS NULL;

-- Hard-delete events that have been soft-deleted for 30+ days
DELETE FROM events
WHERE archived_at < NOW() - INTERVAL '30 days';

-- Similarly for actions_log
UPDATE actions_log
SET ...
```

### 4.2 Privacy

- `users.avatar_url` and `users.display_name` are PII. After the retention period, these fields are nulled (pseudonymization) via the pruning job.
- Hard deletion of a user (GDPR right to erasure) sets `user_id` to `NULL` in `events` and removes the `users` row. Event data (`event_data` JSONB) must also be scrubbed of user fields.
- See [docs/threat-model.md](threat-model.md) (Gemini-owned) for the full data retention and privacy policy.

---

## 5. Aggregates (Optional — Phase 4)

Pre-computed per-stream summaries for the analytics dashboard. Materialized view or separate table, updated by a background job or incremental trigger.

```sql
CREATE TABLE stream_aggregates (
    stream_id          TEXT        PRIMARY KEY REFERENCES streams(id),
    total_events       BIGINT      NOT NULL DEFAULT 0,
    total_chat         BIGINT      NOT NULL DEFAULT 0,
    total_gifts        BIGINT      NOT NULL DEFAULT 0,
    total_likes        BIGINT      NOT NULL DEFAULT 0,
    total_follows      BIGINT      NOT NULL DEFAULT 0,
    total_shares       BIGINT      NOT NULL DEFAULT 0,
    total_joins        BIGINT      NOT NULL DEFAULT 0,
    total_coins        BIGINT      NOT NULL DEFAULT 0,
    peak_viewer_count  INTEGER     NOT NULL DEFAULT 0,
    unique_users       INTEGER     NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

> **Deferred to Phase 4.** Phase 2 analytics will use `COUNT(*)` queries directly against `events`.

---

## 6. Migration Strategy

- Migrations managed with [`node-pg-migrate`](https://www.npmjs.com/package/node-pg-migrate) (or Flyway for Java teams)
- Migration files in `db/migrations/`
- Applied automatically on container startup in development; manually reviewed in production
- Schema version tracked in `schema_migrations` table (managed by migration tool)

---

## 7. ERD (Simplified)

```
streams ──┐
          │1:N
          ├──── sessions ──┐
          │                │1:N
          │                └──── events ────── users (N:1 via user_id)
          │
          └──── rules ──────── actions_log (N:1 via rule_id)
                                    │
                                    └── references events.event_id
```
