# Fixture Catalog — TikTok LIVE Platform

**Owner Agent**: Copilot (QA, CI/CD & Developer Experience Lead)  
**Depends on**: docs/contracts/unified-event.v1.schema.json, docs/architecture.md  
**GitHub Issue**: [#8](https://github.com/rainbowkillah/tiktok-live-platform/issues/8)  
**Status**: Draft — Pending Peer Review

---

## Decision Log

- Fixtures are stored as static JSON files under `src/fixtures/` (one file per canonical event type) so they can be imported by both the fixture validator and test suites without a build step.
- All fixtures conform to `unified-event.v1.schema.json` and are validated on every CI run via `npm run validate-fixtures`.
- The `streamId` `7123456789` and `sessionId` prefix `550e8400-e29b-41d4-a716-44665544000x` are reserved for test use only and must never appear in production data.
- Lifecycle event fixtures (`CONNECTED`, `DISCONNECTED`, `ERROR`) use a synthetic `userId: "0"` / `uniqueId: "system"` user to satisfy the required `user` field while clearly indicating a non-user event.

## Open Questions

1. Should fixtures also include multi-event sequences (e.g., a gift streak: `streakActive=true` → `streakEnd=true`) to test stateful normalization?
2. Should replay-source fixture variants (`source: "replay"`) be maintained alongside live fixtures?
3. How should fixtures be versioned when `unified-event.v1.schema.json` releases a breaking change (v2)?

## Validation Checklist

Reviewers should verify:
- [ ] One fixture file exists per canonical event type (13 total)
- [ ] Each fixture file passes `npm run validate-fixtures`
- [ ] Every required field in the UnifiedEvent envelope is present in every fixture
- [ ] Payload fields match the corresponding `*Payload` definition in the JSON schema
- [ ] `eventId` values in all fixtures are 64-character hex strings (they do not need to be cryptographically correct — they are test identifiers)
- [ ] `streamId`, `sessionId`, `userId` values follow the reserved test-data conventions documented here

---

## 1. Purpose

Test fixtures are **pre-recorded, schema-valid UnifiedEvent JSON objects** that represent every canonical event type the platform can produce. They serve three roles:

1. **Schema validation** — the `validate-fixtures` script (`src/validate-fixtures.js`) runs `ajv` against `unified-event.v1.schema.json` for all 13 fixture files on every CI run, catching schema drift early.
2. **Unit test inputs** — the normalizer, rule engine, and storage-writer unit tests import fixture files as deterministic inputs instead of depending on a live TikTok connection.
3. **Integration / replay tests** — a fixture session (`tests/fixtures/session-replay.json`, see §5) can be injected into the ingest → normalizer → storage pipeline to verify the full vertical slice deterministically.

---

## 2. File Locations

| Path | Description |
|------|-------------|
| `src/fixtures/` | One JSON file per canonical event type |
| `src/validate-fixtures.js` | Ajv-based schema validation script |
| `tests/fixtures/` | Multi-event sequences and session replay fixtures (Phase 2) |
| `docs/contracts/unified-event.v1.schema.json` | Canonical schema all fixtures are validated against |

---

## 3. Fixture Catalog

All fixtures share a common test stream context:

| Field | Test Value |
|-------|------------|
| `streamId` | `7123456789` |
| `sessionId` prefix | `550e8400-e29b-41d4-a716-44665544000x` |
| `source` | `live` |

### 3.1 CHAT — `src/fixtures/chat.fixture.json`

**Trigger ID**: 1  
**Source**: `WebcastChatMessage`

Represents a chat message from `testuser1`. Includes a single emote embedded in the message and a detected language code.

Key payload fields: `message`, `emotes[]`, `language`  
Template placeholders exercised: `{username}`, `{displayName}`, `{message}`

---

### 3.2 GIFT — `src/fixtures/gift.fixture.json`

**Trigger ID**: 2  
**Source**: `WebcastGiftMessage`

Represents a completed gift streak of 10× Rose (10 coins total). `streakActive: false`, `streakEnd: true` marks the final event of the streak.

Key payload fields: `giftId`, `giftName`, `giftCount`, `coins`, `diamondCount`, `streakActive`, `streakEnd`, `giftImageUrl`, `isGiftStreak`  
Template placeholders exercised: `{giftName}`, `{giftCount}`, `{coins}`, `{username}`, `{displayName}`

---

### 3.3 LIKE — `src/fixtures/like.fixture.json`

**Trigger ID**: 3  
**Source**: `WebcastLikeMessage`

Represents a batch of 15 likes. `totalLikeCount` reflects the cumulative stream total at the time of the event.

Key payload fields: `likeCount`, `totalLikeCount`
Template placeholders exercised: `{username}`, `{displayName}`, `{likeCount}`, `{totalLikeCount}`

---

### 3.4 FOLLOW — `src/fixtures/follow.fixture.json`

**Trigger ID**: 4  
**Source**: `WebcastSocialMessage` (`displayType: "pm_mt_msg_viewer_follow"`)

Represents a new follow event. The payload contains `displayType` to document the disambiguation source; the payload object itself is otherwise empty per the `FollowPayload` schema definition.

Key payload fields: `displayType` (documentation only; not in schema)  
Template placeholders exercised: `{username}`, `{displayName}`

---

### 3.5 SHARE — `src/fixtures/share.fixture.json`

**Trigger ID**: 5  
**Source**: `WebcastSocialMessage` (`displayType: "pm_mt_msg_viewer_share"`)

Represents a stream share event. Structurally identical to FOLLOW; differentiated by `displayType`.

Key payload fields: `displayType` (documentation only)  
Template placeholders exercised: `{username}`, `{displayName}`

---

### 3.6 JOIN — `src/fixtures/join.fixture.json`

**Trigger ID**: 6  
**Source**: `WebcastMemberMessage`

Represents a viewer joining the room. Includes the viewer count at join time.

Key payload fields: `viewerCount`, `actionId`  
Template placeholders exercised: `{username}`, `{displayName}`

---

### 3.7 SUBSCRIBE — `src/fixtures/subscribe.fixture.json`

**Trigger ID**: 7  
**Source**: `WebcastSocialMessage` (`displayType: "pm_mt_msg_viewer_subscribe"`)

Represents a 3-month subscription event (`subMonth: 3`).

Key payload fields: `subMonth`
Template placeholders exercised: `{username}`, `{displayName}`, `{subMonth}`

---

### 3.8 EMOTE — `src/fixtures/emote.fixture.json`

**Trigger ID**: 8  
**Source**: `WebcastEmoteChatMessage`

Represents an emote message with a resolved image URL.

Key payload fields: `emoteId`, `emoteImageUrl`, `emoteType`
Template placeholders exercised: `{username}`, `{displayName}`, `{emoteImageUrl}`

---

### 3.9 BATTLE — `src/fixtures/battle.fixture.json`

**Trigger ID**: 9  
**Source**: `WebcastLinkMicBattle`

Represents a battle start event with two participants at score 0. Uses `userId: "0"` / `uniqueId: "system"` for the user envelope since battles are not user-initiated.

Key payload fields: `battleId`, `battleStatus`, `participants[]`  
Template placeholders exercised: none (complex payload; rule engine must access `payload` directly for participant data)

---

### 3.10 CONNECTED — `src/fixtures/connected.fixture.json`

**Trigger ID**: 10  
**Source**: `ControlEvent.CONNECTED`

Lifecycle event emitted when the ingest service establishes a WebSocket connection. Uses the `direct` provider.

Key payload fields: `roomId`, `isConnected`, `provider`  
User: synthetic (`userId: "0"`, `uniqueId: "system"`)

---

### 3.11 DISCONNECTED — `src/fixtures/disconnected.fixture.json`

**Trigger ID**: 11  
**Source**: `ControlEvent.DISCONNECTED`

Lifecycle event emitted when the connection closes normally (`code: 1000`, `willReconnect: false`).

Key payload fields: `code`, `reason`, `willReconnect`  
User: synthetic (`userId: "0"`, `uniqueId: "system"`)

---

### 3.12 ERROR — `src/fixtures/error.fixture.json`

**Trigger ID**: 12  
**Source**: `ControlEvent.ERROR`

Lifecycle event emitted on an ingest connection error. Includes `code: "ECONNRESET"` and a stack trace (stack traces are only included in development mode).

Key payload fields: `message`, `code`, `stack`  
User: synthetic (`userId: "0"`, `uniqueId: "system"`)

---

### 3.13 RAW — `src/fixtures/raw.fixture.json`

**Trigger ID**: 13  
**Source**: `WebcastHourlyRankMessage` (passthrough — no canonical mapping)

Represents an unmapped TikTok event passed through as `RAW`. The `payload.rawType` field preserves the original proto type name; `payload.data` contains the decoded event data.

Key payload fields: `rawType`, `data`  
User: synthetic (`userId: "0"`, `uniqueId: "system"`)

---

## 4. Schema Validation

### Running locally

```bash
npm run validate-fixtures
```

This executes `src/validate-fixtures.js`, which:
1. Loads `docs/contracts/unified-event.v1.schema.json` via `ajv`
2. Loads each of the 13 fixture files
3. Validates each fixture and prints `PASS` / `FAIL` with error details
4. Exits with code `1` if any fixture fails

### CI enforcement

The `validate-fixtures` script runs as a step in the GitHub Actions CI workflow. A failed fixture validation **blocks the PR from merging** (Copilot veto power).

---

## 5. Session Replay Fixture (Phase 2)

In Phase 2, a multi-event session fixture will be added at `tests/fixtures/session-replay.json`. This file will contain an ordered array of UnifiedEvent objects covering a realistic 60-second stream segment:

```
CONNECTED → JOIN × 5 → CHAT × 10 → LIKE × 3 → GIFT × 2 → FOLLOW × 2 → DISCONNECTED
```

This fixture enables a deterministic end-to-end integration test:

1. Inject each event in `session-replay.json` into `ttlc:raw` (replay path)
2. Assert the normalizer produces correct `UnifiedEvent` output for each
3. Assert the storage-writer inserts all events with correct `event_id` (idempotency)
4. Assert the API SSE stream broadcasts all events
5. Re-inject the same events and assert no duplicate rows are created (`ON CONFLICT DO NOTHING`)

The session replay fixture will be created as part of the Phase 2 vertical slice and tracked in the CI pipeline.

---

## 6. Adding New Fixtures

### 6.1 Creating a Fixture Manually

When a new canonical event type is added to `unified-event.v1.schema.json`:

1. Create `src/fixtures/<eventtype>.fixture.json` following the naming convention (lowercase)
2. Add the fixture entry to `FIXTURES` array in `src/validate-fixtures.js`
3. Run `npm run validate-fixtures` locally to confirm it passes
4. Add the fixture to the `tests/fixtures/session-replay.json` sequence if applicable
5. Update this catalog document (§3)
6. Update the Postman collection with an example request/response using the new fixture

### 6.2 Recording a Fixture from a Live TikTok Stream

> **Phase 2+ only.** Phase 1 fixtures are hand-crafted synthetic data; this section documents the Phase 2 recording workflow so it can be planned and reviewed as part of the Phase 1 deliverable. The recording steps below apply once the ingest service is operational.

**Prerequisites**: A running ingest service connected to a TikTok LIVE stream with `NODE_ENV=development` set (enables the raw event logger).

**Step 1 — Capture raw events**

The ingest service writes a newline-delimited JSON log to `logs/raw-events.ndjson` when `RECORD_FIXTURES=true` is set:

```bash
RECORD_FIXTURES=true npm run ingest -- --username <tiktok-username>
```

Each line in `logs/raw-events.ndjson` is a single `UnifiedEvent` JSON object emitted by the normalizer.

**Step 2 — Extract the event of interest**

```bash
# Print all GIFT events from the recording
node -e "
  const fs = require('fs');
  const lines = fs.readFileSync('logs/raw-events.ndjson', 'utf8').split('\n').filter(Boolean);
  for (const [i, line] of lines.entries()) {
    let evt;
    try { evt = JSON.parse(line); } catch (e) { console.error('Parse error at line', i + 1, e.message); continue; }
    if (evt.eventType === 'GIFT') console.log(JSON.stringify(evt, null, 2));
  }
"
```

**Step 3 — Anonymize and sanitize the event** (see §7 for required anonymization steps)

**Step 4 — Save the sanitized fixture**

Copy the sanitized JSON to `src/fixtures/<eventtype>.fixture.json`, then run:

```bash
npm run validate-fixtures
```

### 6.3 Replaying Fixtures Through the Pipeline

> **Phase 2+ only.** The replay pipeline requires a running Redis and Postgres instance (see `docker-compose.test.yml`).

**Step 1 — Start infrastructure**

```bash
docker compose -f docker-compose.test.yml up -d
```

**Step 2 — Inject a single fixture into the pipeline**

```bash
# Publish a single fixture to the ttlc:raw Redis stream
node -e "
  const Redis = require('ioredis');
  const fixture = require('./src/fixtures/gift.fixture.json');
  const redis = new Redis();
  redis.xadd('ttlc:raw', '*', 'data', JSON.stringify(fixture))
    .then(() => { console.log('Injected'); })
    .catch(err => { console.error('Inject failed:', err.message); process.exitCode = 1; })
    .finally(() => redis.disconnect());
"
```

**Step 3 — Inject a full session-replay sequence**

Once `tests/fixtures/session-replay.json` is available (Phase 2), replay the entire sequence:

```bash
node -e "
  const Redis = require('ioredis');
  const events = require('./tests/fixtures/session-replay.json');
  const redis = new Redis();
  (async () => {
    try {
      for (const evt of events) {
        await redis.xadd('ttlc:raw', '*', 'data', JSON.stringify(evt));
      }
      console.log('Injected', events.length, 'events');
    } catch (err) {
      console.error('Inject failed:', err.message);
      process.exitCode = 1;
    } finally {
      redis.disconnect();
    }
  })();
"
```

**Step 4 — Observe output**

- Monitor the SSE stream: `curl -N http://localhost:3000/events`
- Query stored events: `GET /sessions/:id/events`
- Check Redis consumer lag: `redis-cli XINFO GROUPS ttlc:raw`

**Step 5 — Tear down infrastructure**

```bash
docker compose -f docker-compose.test.yml down
```

---

## 7. Data Privacy and Anonymization

### 7.1 Fixture Data Policy

All fixtures in `src/fixtures/` **must use synthetic (hand-crafted) test data**. Fixtures must never contain real TikTok user data, real stream IDs from production streams, or real chat messages.

| Reserved test value | Field | Purpose |
|---|---|---|
| `7123456789` | `streamId` | Fake TikTok room ID reserved for test use |
| `550e8400-e29b-41d4-a716-446655440001`–`446655440013` | `sessionId` | UUID range reserved for test use (last digits 01–13 map to fixture sequence numbers) |
| `1001`–`1099` | `user.userId` | Fake user IDs reserved for test use |
| `testuser1`, `giftgiver99`, etc. | `user.uniqueId` | Pseudonymous test usernames |
| `0` / `system` | `userId` / `uniqueId` | Synthetic identity for lifecycle events |

These reserved values **must never appear in production data**. The storage writer and ingest service must validate this at startup in staging/production environments.

### 7.2 Anonymization Requirements for Recorded Fixtures

If a fixture is derived from a real TikTok stream recording (Phase 2+), the following fields **must be anonymized before committing to the repository**:

| Field | Required treatment |
|---|---|
| `user.userId` | Replace with a value from the reserved `1001`–`1099` range |
| `user.uniqueId` | Replace with a pseudonym (e.g., `testuser1`) |
| `user.displayName` | Replace with a pseudonym (e.g., `Test User One`) |
| `user.avatarUrl` | Replace with `https://example.com/avatar/<userId>.jpg` |
| `streamId` | Replace with `7123456789` |
| `sessionId` | Replace with a value in the reserved UUID range (`550e8400-e29b-41d4-a716-446655440001` – `446655440013`) |
| `payload.message` (CHAT) | Replace with a non-sensitive placeholder (e.g., `"Hello stream!"`) |
| `payload.data` (RAW) | Strip any user-identifiable fields from the nested object |
| `eventId` | Recompute from the sanitized `(streamId, sessionId, seqNo, rawType)` tuple |

### 7.3 Fixture Review Gate

Before any fixture derived from live data is merged into the repository:

1. A peer agent or human reviewer must verify that all fields listed in §7.2 have been anonymized.
2. The PR description must include a statement confirming that no real user data is present.
3. `npm run validate-fixtures` must pass.

### 7.4 Long-term Retention of Raw Recordings

Raw unprocessed recordings (the `logs/raw-events.ndjson` files produced during capture) **must not be committed to the repository**. They should be stored in a private, access-controlled location (e.g., an encrypted S3 bucket) and deleted after the fixture is extracted and anonymized. The `logs/` directory is listed in `.gitignore` to prevent accidental commits.
