# Storage Design — TikTok LIVE Platform

**Owner Agent**: Claude (Program Lead & Systems Architect)
**Depends on**: [docs/architecture.md](architecture.md), [docs/contracts/unified-event.v1.schema.json](contracts/unified-event.v1.schema.json)
**GitHub Issue**: [#3](https://github.com/rainbowkillah/tiktok-live-platform/issues/3)
**Status**: Approved with required changes (applied)

---

## Decision Log

See [decision-log.md](decision-log.md) for all storage choices, alternatives considered, and rationale.

## Open Questions

1. Should `events` use Postgres table partitioning by `session_id` or `timestamp` for performance at scale?
2. Is a separate `aggregates` table worth the added complexity for Phase 2, or is it deferred to Phase 4?
3. ~~Should `users` table pseudonymize data after the retention period, or hard-delete?~~ **[RESOLVED]** Pseudonymize: null PII fields (`display_name`, `avatar_url`) and replace `tiktok_user_id` / `unique_id` with SHA-256 hashes. Hard-delete risks breaking `events.user_id` references and audit history. See §4.1 Step 6 and §4.2.

## Validation Checklist

Reviewers should verify:
- [x] All 6 core tables are defined with column types, constraints, and indexes
- [x] `events` is append-only (no UPDATE/DELETE policy is explicit)
- [x] Replayability path is described end-to-end
- [x] Retention policy covers TTL, pruning mechanism, and privacy implications
- [x] Index strategy covers expected query patterns (live feed, history, per-user, per-type)
- [x] `rules` and `actions_log` tables support the rule engine contract

**Codex review**: ✅ Approved with required changes (applied) — see [reviews.codex.md](reviews.codex.md)  
**Copilot review**: ✅ Approved — replay, retention, and idempotent insert scenarios validated — see [reviews.copilot.md](reviews.copilot.md)  
**Gemini review**: ✅ Approved — Privacy and UX requirements satisfied — see [reviews.gemini.md](reviews.gemini.md)

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
    raw_type       TEXT,                           -- Original WebcastEvent/proto type (e.g., 'WebcastGiftMessage'); always populated; indexed for RAW filtering
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
- GDPR right-to-erasure updates are performed only by a dedicated admin script (`scripts/gdpr-erasure.ts`) in a single DB transaction
- A `RULE` or trigger that blocks UPDATE/DELETE can be added in Phase 4 hardening

**Columns:**
- `event_id` — SHA-256 of `(streamId + ':' + sessionId + ':' + seqNo + ':' + rawType)` as specified in `unified-event.v1.schema.json`. The `sessionId` component ensures replay events (new session) receive distinct `event_id` values, so replay rows are always inserted as new records. Idempotent re-delivery within the same session is handled by `ON CONFLICT (event_id) DO NOTHING`.
- `event_data` — the full UnifiedEvent JSON blob. This is the source of truth; other columns are denormalized for query performance
- `seq_no` — TikTok sequence number from the WebSocket frame; used as an ordering key for replay
- `trigger_id` — numeric trigger mapping aligned to `UnifiedEvent.triggerId` for fast rule filtering and dispatch analytics
- `raw_type` — the original WebcastEvent/proto type name (e.g., `WebcastGiftMessage`). Populated for all events; required and indexed for `event_type='RAW'` filtering without JSONB traversal

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
| `streams` | 1 year | `STREAM_RETENTION_DAYS` env var |
| `sessions` | 1 year | `SESSION_RETENTION_DAYS` env var |
| `users` | 1 year (inactive) | `USER_RETENTION_DAYS` env var |
| `rules` | Indefinite | Manual admin only |

### 4.1 Pruning Job

A scheduled job (cron or pg_cron) runs daily at 02:00 UTC. All steps run in order within a single transaction or as sequenced statements to respect FK dependencies.

```sql
-- ============================================================
-- DAILY PRUNING JOB  (run via cron or pg_cron at 02:00 UTC)
-- Requires: pgcrypto extension for user pseudonymization
-- ============================================================

-- Step 1: Soft-delete expired events (90-day retention)
UPDATE events
SET archived_at = NOW()
WHERE timestamp < NOW() - INTERVAL '90 days'
  AND archived_at IS NULL;

-- Step 2: Hard-delete events that have been soft-deleted for 30+ days
DELETE FROM events
WHERE archived_at < NOW() - INTERVAL '30 days';

-- Step 3: Hard-delete old actions_log rows (90-day retention, no soft-delete)
DELETE FROM actions_log
WHERE executed_at < NOW() - INTERVAL '90 days';

-- Step 4: Hard-delete old sessions
--   Guard: only delete after all referenced events are gone.
--   events max lifetime = 90d soft-delete + 30d grace = 120d.
--   sessions retention = 1 year — safe ordering gap.
DELETE FROM sessions
WHERE created_at < NOW() - INTERVAL '1 year'
  AND NOT EXISTS (
    SELECT 1 FROM events WHERE events.session_id = sessions.id
  );

-- Step 5: Hard-delete old streams
--   Guard: only delete after all referenced sessions are gone.
DELETE FROM streams
WHERE created_at < NOW() - INTERVAL '1 year'
  AND NOT EXISTS (
    SELECT 1 FROM sessions WHERE sessions.stream_id = streams.id
  );

-- Step 6: Pseudonymize inactive users (1-year inactivity threshold)
--   Algorithm: HMAC-SHA256 with PSEUDONYMIZATION_SECRET (see D-011 and storage.md §4.2).
--   Uses meta->>'pseudonymizedAt' as an idempotency guard to prevent re-hashing.
--   Requires pgcrypto: CREATE EXTENSION IF NOT EXISTS pgcrypto;
--   Pass the secret as a query parameter ($1) from the calling script/job.
UPDATE users
SET display_name   = NULL,
    avatar_url     = NULL,
    unique_id      = encode(hmac(unique_id,      $1, 'sha256'), 'hex'),
    tiktok_user_id = encode(hmac(tiktok_user_id, $1, 'sha256'), 'hex'),
    meta           = meta || jsonb_build_object('pseudonymizedAt', NOW())
WHERE last_seen < NOW() - INTERVAL '1 year'
  AND (meta->>'pseudonymizedAt') IS NULL;
-- Note: $1 is the PSEUDONYMIZATION_SECRET env var, injected by the pruning script,
-- never hardcoded in SQL. The corresponding events.user_id update must run in the
-- same transaction: UPDATE events SET user_id = encode(hmac(user_id, $1, 'sha256'), 'hex')
-- WHERE user_id IN (SELECT tiktok_user_id FROM users WHERE ...) AND archived_at IS NULL;
```

**Retention ordering note**: Steps 1–3 (events and actions_log at 90 days) always run before steps 4–5 (sessions and streams at 1 year), ensuring FK references from `events` and `actions_log` to `sessions` and `streams` are cleared before parent rows are deleted.

**Configurable intervals**: All intervals above correspond to the env vars in §4. In production, substitute `INTERVAL '90 days'` with a parameterized value from `EVENT_RETENTION_DAYS` / `ACTIONS_LOG_RETENTION_DAYS`, and `INTERVAL '1 year'` with `SESSION_RETENTION_DAYS` / `STREAM_RETENTION_DAYS` / `USER_RETENTION_DAYS`.

### 4.2 Privacy

**Pseudonymization algorithm**: HMAC-SHA256 with a deployment-specific server secret (see [D-011](decision-log.md#d-011-pseudonymization-strategy--hmac-sha256-with-server-secret) for full rationale and rejected alternatives).

| Field | Retention action | Reason |
|-------|-----------------|--------|
| `users.tiktok_user_id` | `encode(hmac(value, $PSEUDONYMIZATION_SECRET, 'sha256'), 'hex')` | Identifier — HMAC preserves referential integrity with `events.user_id` while resisting rainbow table attacks on enumerable numeric IDs |
| `users.unique_id` | `encode(hmac(value, $PSEUDONYMIZATION_SECRET, 'sha256'), 'hex')` | Identifier — same rationale |
| `users.display_name` | `NULL` | Display value — no relational integrity role; nulling is sufficient |
| `users.avatar_url` | `NULL` | Display value — URL is PII (third-party CDN path); nulling is sufficient |
| `events.user_id` | Updated to match new `users.tiktok_user_id` HMAC in the same transaction | Maintains FK-like consistency between tables |
| `events.event_data` PII fields (`displayName`, `avatarUrl`) | Scrubbed to `null` | Prevents PII leakage via JSONB payload |

**Requirements**:
- `pgcrypto` extension must be installed: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`
- `PSEUDONYMIZATION_SECRET` env var must be set at service startup (minimum 32 bytes recommended); add to `.env.example` and secret manager.
- Secret rotation: re-hashing all pseudonymized rows is required to maintain cross-table consistency after rotation. Old hashes become uncorrelated with new ones if rotation is not atomic.

- GDPR right-to-erasure is automated via `scripts/gdpr-erasure.ts`. The script pseudonymizes the `users` row (`tiktok_user_id`, `unique_id`, `display_name`, `avatar_url`) using HMAC-SHA256, updates matching `events.user_id`, and scrubs PII fields from `events.event_data` JSONB.
- Every successful erasure writes an audit record to `actions_log` (requires a valid `rules.id` passed as `--audit-rule-id` or `GDPR_AUDIT_RULE_ID`).

**How to run (`scripts/gdpr-erasure.ts`):**

```bash
# 1) Configure database connection
export DATABASE_URL='postgres://user:pass@localhost:5432/ttlc'

# 2) Provide a dedicated audit rule id (existing rules.id)
export GDPR_AUDIT_RULE_ID='00000000-0000-0000-0000-000000000000'

# 3a) Erase by TikTok numeric user id
npm run gdpr:erase -- --userId 1234567890

# 3b) Erase by unique handle
npm run gdpr:erase -- --uniqueId streamer_handle
```

**Output contract:**
- JSON summary with `rowsAffected`, `tablesTouched`, and `timestamp`
- Exit code `0` on success
- Non-zero exit code on failure (transaction rollback prevents partial erasure)

**Pre-flight checklist:**
- Confirm target user identity (`userId` or `uniqueId`)
- Confirm `GDPR_AUDIT_RULE_ID` references a valid `rules.id`
- Run in a privileged maintenance context (not application runtime credentials)
- See [docs/privacy-policy.md](privacy-policy.md) (Gemini-owned) for the full data retention and privacy policy.

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
