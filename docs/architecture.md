# Architecture — TikTok LIVE Platform

**Owner Agent**: Claude (Program Lead & Systems Architect)
**Depends on**: None (root document)
**GitHub Issue**: [#241](https://github.com/rainbowkillah/crispy-enigma/issues/241)
**Status**: Draft — Pending peer review

---

## Decision Log

See [decision-log.md](decision-log.md) for all architectural choices, alternatives considered, and rationale.

## Open Questions

1. Should the Euler WS API be the default `INGEST_PROVIDER` in production, or fallback-only?
2. Is Redis Streams sufficient for Phase 2, or should we evaluate NATS now?
3. Do we need a separate `ui` container or should the API serve static assets?

## Validation Checklist

Reviewers should verify:
- [ ] All 5 services are defined with clear input/output boundaries
- [ ] Data flow diagram accurately represents the pipeline
- [ ] Env var reference covers all externalized configuration
- [ ] Risk register covers TikTok fragility, rate limits, proto drift, and session secrets
- [ ] Replayability path is explicitly described
- [ ] Redis Streams contracts (`ttlc:raw`, `ttlc:events`, `ttlc:dlq`) are field-level explicit
- [ ] Deployment topology (Docker Compose first) is enforced

---

## 1. Mission

This platform ingests raw TikTok LIVE events, normalizes them into a stable versioned schema (**UnifiedEvent v1**), stores them append-only for replay and analytics, and exposes them to three downstream consumers: a Web UI, a Streamer Forwarder, and a long-term analytics store.

The ingestion layer wraps [`tiktok-live-connector`](https://www.npmjs.com/package/tiktok-live-connector) (npm) and its `TikTokLiveConnection` class. A stable Euler WebSocket API fallback is also supported.

---

## 2. Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TikTok LIVE                                  │
│            (WebSocket / Euler WS API)                               │
└───────────────────────┬─────────────────────────────────────────────┘
                        │ raw proto frames
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  [1] INGEST SERVICE                                                 │
│  • Wraps TikTokLiveConnection (tiktok-live-connector)               │
│  • Also supports Euler WS API (INGEST_PROVIDER=euler|direct)        │
│  • Emits lifecycle events: CONNECTED, DISCONNECTED, ERROR           │
│  • Publishes raw event frames → Redis Stream: ttlc:raw              │
└───────────────────────┬─────────────────────────────────────────────┘
                        │ Redis Stream: ttlc:raw
                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│  [2] NORMALIZER SERVICE                                             │
│  • Consumer group on ttlc:raw                                       │
│  • Maps WebcastEvent / proto type name → UnifiedEvent canonical type│
│  • Adds: eventId (sha256 dedupe), schemaVersion, source, user fields│
│  • Social sub-type disambiguation (FOLLOW vs SHARE vs SUBSCRIBE)    │
│  • Publishes UnifiedEvent JSON → Redis Stream: ttlc:events          │
└───────────────────────┬─────────────────────────────────────────────┘
                        │ Redis Stream: ttlc:events
               ┌────────┼──────────────┬──────────────────┐
               ▼        ▼              ▼                  ▼
    ┌──────────────┐ ┌───────────┐ ┌────────────┐ ┌──────────────┐
    │ [3] STORAGE  │ │  [4] API  │ │   RULE     │ │  [5] STREAMER│
    │   WRITER     │ │ (REST+SSE)│ │  ENGINE    │ │  FORWARDER   │
    │              │ │           │ │            │ │              │
    │ Postgres     │ │ Live feed │ │ Match rules│ │ Re-emits to  │
    │ append-only  │ │ via SSE/WS│ │ Render     │ │ Euler API    │
    │ events table │ │ REST for  │ │ templates  │ │ Retry/backoff│
    │              │ │ history   │ │ Execute    │ │ Dead-letter  │
    └──────────────┘ └─────┬─────┘ │ actions    │ │ queue        │
                           │       └────────────┘ └──────────────┘
                           ▼
                    ┌─────────────┐
                    │   [UI]      │
                    │  Web App    │
                    │  Streamer & │
                    │  Moderator  │
                    │  Views      │
                    └─────────────┘
```

---

## 3. Services

### 3.1 Ingest Service (`ingest`)

| Property | Value |
|----------|-------|
| Language | Node.js / TypeScript |
| Input | TikTok LIVE WebSocket (direct or Euler) |
| Output | Redis Stream `ttlc:raw` |
| Key dependency | `tiktok-live-connector` npm package |

**Responsibilities:**
- Manages the `TikTokLiveConnection` lifecycle (connect, reconnect with exponential back-off, disconnect)
- Supports two providers via `INGEST_PROVIDER` env var:
  - `direct` — uses `TikTokLiveConnection` from `tiktok-live-connector`
  - `euler` — uses Euler WS API (preferred for production stability)
- Emits lifecycle events (`CONNECTED`, `DISCONNECTED`, `ERROR`) alongside payload events
- Publishes raw frames as JSON to `ttlc:raw` with fields: `type`, `data` (base64 or JSON), `streamId`, `seqNo`, `ingestedAt`
- Supports `--replay-session <id>` flag: reads stored events from Postgres and re-publishes them to `ttlc:raw` with `source=replay`

**Reconnect policy:**
- Initial back-off: 1 s
- Max back-off: 60 s
- Multiplier: 2×
- Jitter: ±20%
- Max attempts: configurable (`RECONNECT_MAX_ATTEMPTS`, default unlimited)

---

### 3.2 Normalizer Service (`normalizer`)

| Property | Value |
|----------|-------|
| Language | Node.js / TypeScript |
| Input | Redis Stream `ttlc:raw` (consumer group `normalizer`) |
| Output | Redis Stream `ttlc:events` |

**Responsibilities:**
- Reads from consumer group `normalizer` on `ttlc:raw`
- Looks up `type` in the trigger-type mapping table (see §5) to get the canonical `eventType`
- Constructs a `UnifiedEvent` conforming to `unified-event.v1.schema.json`
- Computes `eventId = sha256(streamId + ":" + seqNo + ":" + type)` for idempotent storage
- **Social sub-type disambiguation**: `WebcastSocialMessage` maps to `FOLLOW`, `SHARE`, or `SUBSCRIBE` based on the `displayType` field in the proto payload
- Publishes `UnifiedEvent` JSON to `ttlc:events`
- Emits a `PARSE_ERROR` dead-letter message to `ttlc:dlq` if normalization fails

---

### 3.3 Storage Writer (`storage-writer`)

| Property | Value |
|----------|-------|
| Language | Node.js / TypeScript |
| Input | Redis Stream `ttlc:events` (consumer group `storage`) |
| Output | PostgreSQL `events` table |

**Responsibilities:**
- Consumes from consumer group `storage` on `ttlc:events`
- Upserts `users` record on each event (update `last_seen`)
- Inserts into `events` table (append-only; no UPDATE/DELETE)
- Updates `streams` and `sessions` records as needed
- Handles duplicate `eventId` via `ON CONFLICT DO NOTHING`

---

### 3.4 API Service (`api`)

| Property | Value |
|----------|-------|
| Language | Node.js / TypeScript (Fastify or Express) |
| Input | Redis Stream `ttlc:events` (live), PostgreSQL (history) |
| Output | REST endpoints, SSE stream, WebSocket |

**Responsibilities:**
- Exposes REST API for historical queries (events, sessions, streams, users, rules)
- Exposes SSE endpoint `/streams/:streamId/events` for live event feed
- Exposes WebSocket endpoint for bidirectional UI communication
- Provides session replay trigger endpoint (`POST /sessions/:id/replay`)
- Serves static Web UI assets (or delegates to separate Nginx container)

**Key endpoints (planned):**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/streams/:id/events` | SSE live feed |
| `GET` | `/sessions/:id/events` | Historical event query |
| `POST` | `/sessions/:id/replay` | Trigger replay |
| `GET` | `/rules` | List rules |
| `POST` | `/rules` | Create rule |
| `PUT` | `/rules/:id` | Update rule |
| `DELETE` | `/rules/:id` | Delete rule |
| `GET` | `/health` | Health check |

---

### 3.5 Web UI (`ui`)

| Property | Value |
|----------|-------|
| Stack | React + Vite (TBD by Gemini) |
| Served by | `api` service or separate Nginx container |

**Views:**
- **Streamer view**: live event feed (filters/search), rule editor, analytics dashboard, replay controls
- **Moderator view**: filtered event feed, user quick-actions, per-user notes, rule trigger testing

> UI information architecture and flows are defined in [docs/ui-flows.md](ui-flows.md) (Gemini-owned).

---

### 3.6 Rule Engine (embedded in `api` or separate service)

**Responsibilities:**
- Matches incoming `UnifiedEvent` against stored rules
- Rule structure: `{ eventType, condition: jsonLogic, action: { type, template } }`
- Template rendering: replaces `{username}`, `{displayName}`, `{giftName}`, `{giftCount}`, `{coins}`, `{message}`, `{eventType}`, `{timestamp}`, `{streamId}` with values from the event
- Supported actions: `announce` (send chat message), `moderate` (timeout/ban), `webhook` (POST to external URL), `log` (audit log only)
- All executions logged to `actions_log` table

---

### 3.7 Streamer Forwarder (`forwarder`, embedded in `api` or separate)

**Responsibilities:**
- Consumes `ttlc:events` and re-emits to the Euler Stream API
- Implements retry with exponential back-off (initial 500 ms, max 30 s, multiplier 2×)
- Dead-letter queue: events that exceed max retries go to `ttlc:dlq`
- Records audit log and metrics (forwarded count, retry count, DLQ count)

---

### 3.8 Service Boundary & Redis Stream Contract (Implementation Gate)

This section defines implementation-level contracts so each service can ship independently without hidden coupling.

#### Boundary rules (must hold)

- **Ingest** publishes raw envelopes to `ttlc:raw` and does not write to Postgres.
- **Normalizer** consumes `ttlc:raw` and publishes canonical envelopes to `ttlc:events`.
- **Storage Writer** is the only service that persists canonical events into Postgres tables.
- **API / Rule Engine / Forwarder** consume canonical events from `ttlc:events` and must not depend on `ttlc:raw` internals.
- **Replay** follows the same contracts (`ttlc:raw` → `ttlc:events`) with `source='replay'` and a new `sessionId`.

#### Redis Stream contract v1

**Stream: `ttlc:raw` (producer: ingest, consumer group: `normalizer`)**

| Field | Type | Required | Notes |
|------|------|----------|-------|
| `schemaVersion` | string | yes | Fixed to `raw.v1` for envelope compatibility |
| `streamId` | string | yes | TikTok room ID |
| `sessionId` | string (uuid) | yes | Created on connect/reconnect/replay start |
| `source` | enum(`live`,`replay`) | yes | Distinguishes live ingest from replay |
| `type` | string | yes | Raw TikTok event/proto type |
| `seqNo` | integer >= 0 | yes | Ordering + dedupe input |
| `timestamp` | ISO datetime | yes | Event time if available, else ingest time |
| `ingestedAt` | ISO datetime | yes | Ingest service receive time |
| `data` | JSON object or base64 string | yes | Raw payload |

**Stream: `ttlc:events` (producer: normalizer, consumer groups: `storage`, `api`, `forwarder`)**

- Message field `event` contains serialized `UnifiedEvent v1` JSON.
- Normalizer validates payloads against `docs/contracts/unified-event.v1.schema.json` before publish.
- Optional field `normalizedAt` (ISO datetime) is allowed for observability.

**Stream: `ttlc:dlq` (producer: normalizer/forwarder, consumer group: ops)**

| Field | Type | Required | Notes |
|------|------|----------|-------|
| `stage` | string | yes | `normalizer` or `forwarder` |
| `reason` | string | yes | Parse/validation/forwarding error category |
| `error` | string | yes | Sanitized error message |
| `payload` | string | yes | Original message body |
| `failedAt` | ISO datetime | yes | Failure timestamp |

#### Consumer-group semantics

- Use explicit groups: `normalizer` on `ttlc:raw`; `storage`, `api`, `forwarder` on `ttlc:events`.
- Acknowledge (`XACK`) only after side effects complete (publish or DB commit).
- Retry failures with bounded attempts; exhausted items go to `ttlc:dlq`.
- Cap streams (`XADD ... MAXLEN ~`) to prevent unbounded Redis growth while Postgres remains source of truth.

#### Implementability verdict

- **Service boundaries are implementable** with this contract.
- **Redis Stream contract is implementable** once producers/consumers enforce required fields and ack semantics.
- No cross-service circular dependency remains under this boundary model.

---

## 4. Deployment Topology

### Phase 2 (Local — Docker Compose)

```
docker-compose.yml
├── postgres        (port 5432)
├── redis           (port 6379)
├── ingest          (no exposed port; publishes to Redis)
├── normalizer      (no exposed port; consumes/publishes Redis)
├── storage-writer  (no exposed port; writes to Postgres)
├── api             (port 3000 → REST/SSE/WS)
└── ui              (port 5173 → Vite dev server, or served by api)
```

All services share a single Docker network. Secrets are injected via `.env` file (never committed; see `.gitignore`).

### Phase 4+ (Cloud)

- **API**: Cloudflare Workers or Vercel Edge Functions (stateless REST/SSE)
- **Postgres**: Neon, Supabase, or Railway managed Postgres
- **Redis**: Upstash Redis (serverless-compatible)
- **UI**: Vercel / Cloudflare Pages
- **Ingest + Normalizer**: Long-running Node process (Railway, Fly.io, or dedicated VPS — cannot be serverless due to persistent WebSocket connection)

---

## 5. Trigger-Type Mapping

The normalizer uses this table to map raw TikTok event names to canonical UnifiedEvent types.

| Proto / WebcastEvent Name | UnifiedEvent `eventType` | Notes |
|---------------------------|--------------------------|-------|
| `WebcastChatMessage` | `CHAT` | |
| `WebcastGiftMessage` | `GIFT` | Uses separate gift handler in connector |
| `WebcastLikeMessage` | `LIKE` | |
| `WebcastMemberMessage` | `JOIN` | Member joins the stream |
| `WebcastSocialMessage` (displayType=`pm_mt_msg_viewer_follow`) | `FOLLOW` | Sub-type disambiguation |
| `WebcastSocialMessage` (displayType=`pm_mt_msg_viewer_share`) | `SHARE` | Sub-type disambiguation |
| `WebcastSocialMessage` (displayType=`pm_mt_msg_viewer_subscribe`) | `SUBSCRIBE` | Sub-type disambiguation |
| `WebcastEmoteChatMessage` | `EMOTE` | |
| `WebcastLinkMicBattle` | `BATTLE` | |
| `WebcastLinkMicArmies` | `BATTLE` | Battle armies update |
| `WebcastBarrageMessage` | `BATTLE` | Super fan / battle barrage |
| `WebcastRoomUserSeqMessage` | `ROOM_USER` | Viewer count update (passthrough) |
| `WebcastControlMessage` | `STREAM_END` | Stream end control message |
| `ControlEvent.CONNECTED` | `CONNECTED` | Lifecycle |
| `ControlEvent.DISCONNECTED` | `DISCONNECTED` | Lifecycle |
| `ControlEvent.ERROR` | `ERROR` | Lifecycle |

> All other `WebcastEvent` types (hourly rank, goal update, poll, etc.) are passed through as `RAW` events with their original type name preserved in `payload.rawType`. This ensures no data is lost while the schema evolves.

---

## 6. Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `INGEST_PROVIDER` | `direct` | `direct` or `euler` |
| `TIKTOK_UNIQUE_ID` | — | TikTok username to connect to |
| `EULER_API_KEY` | — | Euler Stream API key (required if `INGEST_PROVIDER=euler`) |
| `SESSION_ID` | — | TikTok session cookie (for authenticated chat send) — treat as secret |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `DATABASE_URL` | `postgresql://...` | Postgres connection string — treat as secret |
| `API_PORT` | `3000` | API service listen port |
| `RECONNECT_MAX_ATTEMPTS` | `0` (unlimited) | Max reconnect attempts for ingest |
| `EVENT_RETENTION_DAYS` | `90` | Days before events are eligible for pruning |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

> **Security**: `SESSION_ID`, `DATABASE_URL`, and `EULER_API_KEY` are radioactive. Never commit them. Inject via `.env` locally; use secret management (e.g., Doppler, Railway secrets, GitHub Actions secrets) in CI/CD.

---

## 7. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|------------|--------|------------|
| R-01 | TikTok changes WebSocket protocol / proto schema | High | High | Use Euler WS API as stable fallback; pin `tiktok-live-connector` version; monitor changelog |
| R-02 | TikTok rate-limits or CAPTCHAs the connector | Medium | High | Implement exponential back-off; rotate IPs if needed; document known limits |
| R-03 | `sessionId` / JWT secret leaked to repo | Low | Critical | `.gitignore` + secret scanning in CI; never log secrets |
| R-04 | High event volume degrades UI (10k+ events/min) | Medium | Medium | Virtualized list rendering; SSE backpressure; client-side rate limiting |
| R-05 | Proto schema drift between connector and platform | Medium | Medium | Integration tests against real fixtures; schema version field in UnifiedEvent |
| R-06 | Redis Stream backlog grows unbounded | Low | Medium | Configure `MAXLEN` on streams; monitor consumer lag |
| R-07 | Postgres storage grows unbounded | Medium | Low | 90-day TTL pruning job; optional aggregates table |
| R-08 | Euler API outage | Low | High | Fall back to `direct` provider; alert on DLQ growth |
| R-09 | Rule engine executes unauthorized actions | Low | High | Allowlist action types; sandbox webhook destinations; require auth to create rules |
| R-10 | GDPR / privacy: user PII stored indefinitely | Medium | Medium | 90-day retention; user deletion endpoint; pseudonymize after retention period |

---

## 8. Non-Negotiables

1. **Local-first**: Docker Compose must be working before any cloud deployment.
2. **Schema-first**: `unified-event.v1.schema.json` and `storage.md` are approved before `normalizer` or `storage-writer` are implemented.
3. **Replayability**: Every session must be replayable via `--replay-session <id>` or the API.
4. **Observability**: Structured JSON logging and basic Redis/Postgres metrics by end of Phase 2.
5. **No lone-wolf merges**: All deliverables require peer review before merge.
