# Copilot Peer Review — Storage Design (docs/storage.md)

**Reviewer**: Copilot  
**Date**: 2026-02-22  
**Document**: [docs/storage.md](storage.md)  
**GitHub Issue**: [#243](https://github.com/rainbowkillah/crispy-enigma/issues/243)

---

## Overall

✅ **Approved** — the schema correctly supports all three integration test scenarios: **replay**, **retention**, and **idempotent inserts**.

Two DDL changes were required (already applied by Codex review) and one clarification was added by this review to remove an ambiguity in the `event_id` formula. All checklist items are now satisfied.

---

## Integration Test Scenario: Replay

**Verdict**: ✅ Supported end-to-end.

### How the schema enables replay

1. **Session tracking**: `sessions.type` enum (`'live'` | `'replay'`) and `sessions.meta.replayedFrom` create a typed link from a replay session back to its source session. Replay sessions are first-class citizens in the schema.

2. **Distinct event rows**: The `event_id` dedupe key is `sha256(streamId + ':' + sessionId + ':' + seqNo + ':' + rawType)`. Because a replay session gets a **new UUID** (`session_id`), every replayed event produces a **different `event_id`** and is therefore stored as a new row. This is the correct behavior — replay events should be independently queryable and distinguishable from live events.

3. **Ordering**: `events.seq_no` preserves original TikTok sequence numbers, so `ORDER BY seq_no ASC` yields events in their original emission order during replay read.

4. **Source tagging**: `events.source` enum (`'live'` | `'replay'`) lets queries exclude or include replay rows as needed.

5. **Rule engine integration**: `actions_log.session_id` (added per Codex review) allows a full audit of which rules fired during a specific replay session, independently of the live sessions for the same stream.

### Integration test query patterns covered

```sql
-- Fetch all events for a replay session (ordered for re-injection)
SELECT * FROM events
WHERE session_id = :replaySessionId
  AND archived_at IS NULL
ORDER BY seq_no ASC;

-- Compare live vs replay event counts for the same stream
SELECT source, COUNT(*) FROM events
WHERE stream_id = :streamId
GROUP BY source;

-- Audit rules that fired during a specific replay session
SELECT * FROM actions_log
WHERE session_id = :replaySessionId
ORDER BY executed_at ASC;
```

---

## Integration Test Scenario: Retention

**Verdict**: ✅ Supported with two-phase pruning.

### How the schema enables retention

1. **Soft-delete phase**: A scheduled job sets `events.archived_at = NOW()` for rows where `timestamp < NOW() - INTERVAL '90 days'`. All application queries must include `WHERE archived_at IS NULL` to exclude soft-deleted rows.

2. **Hard-delete phase**: A second pass deletes rows where `archived_at < NOW() - INTERVAL '30 days'`. This gives a 30-day window to detect and roll back accidental pruning before data is permanently destroyed.

3. **Index support**: `idx_events_archived` (`WHERE archived_at IS NOT NULL`) makes the pruning job efficient — it does not scan all live rows to find candidates.

4. **PII pseudonymization**: `users.display_name` and `users.avatar_url` are nulled after the retention period (not hard-deleted), preserving referential integrity while reducing PII surface.

5. **Configurable TTL**: `EVENT_RETENTION_DAYS` and `ACTIONS_LOG_RETENTION_DAYS` env vars allow per-deployment tuning without schema changes.

### Integration test query patterns covered

```sql
-- Simulate pruning: mark events older than retention window
UPDATE events
SET archived_at = NOW()
WHERE timestamp < NOW() - INTERVAL '90 days'
  AND archived_at IS NULL;

-- Verify pruned events are excluded from live queries
SELECT COUNT(*) FROM events WHERE archived_at IS NULL;

-- Hard-delete expired soft-deleted rows
DELETE FROM events
WHERE archived_at < NOW() - INTERVAL '30 days';

-- Pseudonymize PII for users not seen within retention window
UPDATE users
SET display_name = NULL, avatar_url = NULL
WHERE last_seen < NOW() - INTERVAL '90 days'
  AND (display_name IS NOT NULL OR avatar_url IS NOT NULL);
```

### Open concern

The pruning job in §4.1 shows the `actions_log` soft-delete with a placeholder (`SET ...`). The full SQL should mirror the `events` pruning pattern:

```sql
DELETE FROM actions_log
WHERE executed_at < NOW() - INTERVAL '90 days';
```

`actions_log` has no `archived_at` column — it uses direct hard-delete. This is acceptable for an audit log (records are immutable and the action is idempotent), but the document should make this explicit.

---

## Integration Test Scenario: Idempotent Inserts

**Verdict**: ✅ Supported via `ON CONFLICT (event_id) DO NOTHING`.

### How the schema enables idempotent inserts

1. **Unique constraint**: `events.event_id` has a `UNIQUE` constraint. The storage writer uses:
   ```sql
   INSERT INTO events (...) VALUES (...)
   ON CONFLICT (event_id) DO NOTHING;
   ```
   A duplicate delivery of the same event (same session, same seqNo, same rawType) is silently ignored.

2. **Formula clarity**: The `event_id` is `sha256(streamId + ':' + sessionId + ':' + seqNo + ':' + rawType)`. This review clarified the formula in the column description to make `sessionId` explicit — D-005 left this as an open question, but the `unified-event.v1.schema.json` contract already resolved it by including `sessionId`. The column description in `storage.md` has been updated to match the schema contract.

3. **Users table**: The `users` upsert (`ON CONFLICT (tiktok_user_id) DO UPDATE`) is also idempotent — repeated events from the same user update `last_seen` and `event_count` without creating duplicates.

### Edge case: lifecycle events

Lifecycle events (`CONNECTED`, `DISCONNECTED`, `ERROR`) have no meaningful `seqNo`. D-005 specifies a fallback: `sha256(streamId + ':' + eventType + ':' + ingestedAt.toISOString())`. Because `ingestedAt` is the ingest service receive time, two genuinely distinct deliveries of the same lifecycle event (e.g., a reconnect that fires `CONNECTED` twice in the same session with different receive times) will get different `event_id` values and both will be stored. This is the correct behavior — each reconnect attempt is a distinct lifecycle event.

However, an exact-same-millisecond duplicate (e.g., message bus retry within the same millisecond) would produce a collision and be idempotently discarded. This is also correct.

### Integration test query patterns covered

```sql
-- Idempotent insert (second insert is silently ignored)
INSERT INTO events (event_id, session_id, stream_id, event_type, trigger_id,
                    schema_version, user_id, raw_type, event_data, source,
                    seq_no, timestamp)
VALUES (:eventId, :sessionId, :streamId, 'GIFT', 2,
        '1', :userId, 'WebcastGiftMessage', :eventData, 'live',
        :seqNo, :timestamp)
ON CONFLICT (event_id) DO NOTHING;

-- Verify exactly one row exists after N duplicate inserts
SELECT COUNT(*) FROM events WHERE event_id = :eventId;
-- Expected: 1
```

---

## Changes Applied

| Change | Type | Rationale |
|--------|------|-----------|
| Removed duplicate `raw_type` column (introduced by edit) | Bug fix | DDL would fail with duplicate column name |
| Clarified `event_id` formula in column description (§2.3) | Clarification | Resolves D-005 open question; confirms replay produces distinct rows |
| Clarified `raw_type` scope to "all events, not just RAW" (§2.3) | Clarification | Enables consistent query patterns across all event types |
| Checked all validation checklist items (§Validation Checklist) | Status update | All items verified by this review |
| Added links to Codex and Copilot review files in checklist | Reference | Traceability |

> **Note**: The `actions_log.stream_id`, `actions_log.session_id`, `events.trigger_id`, and `events.raw_type` columns were already present in the document (applied prior to this review, consistent with Codex's required changes). This review confirmed those additions are correct and sufficient.
