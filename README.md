# TikTok LIVE Platform

Production-ready event platform for ingesting, normalizing, storing, and acting on TikTok LIVE stream events.

> **GitHub Project**:
> [Project Issues](https://github.com/rainbowkillah/tiktok-live-platform/issues)
> [Project Roadmap](https://github.com/users/rainbowkillah/projects/15/views/1)
> [Project Board](https://github.com/users/rainbowkillah/projects/15/views/2)
> [Project Table](https://github.com/users/rainbowkillah/projects/15/views/3)

> **Status (2026-02-23)**: Phase 1 deliverables in progress. Issue `#9` (`src/types/unified-event.ts`) is implemented locally with schema-aligned discriminated unions.

## Overview

This platform wraps [`tiktok-live-connector`](https://www.npmjs.com/package/tiktok-live-connector) as its ingestion layer and adds:

- A normalization pipeline mapping TikTok events → **UnifiedEvent v1**
- An append-only event store (PostgreSQL)
- A real-time event bus (Redis Streams)
- A REST + SSE/WebSocket API for downstream consumers
- A Web UI for streamers and moderators
- A rule engine with template rendering and action execution
- A streamer forwarder with retry/back-off and dead-letter queue

## Current Snapshot

- Branch `main` is synced with `origin/main`.
- Worktree currently contains local, uncommitted Phase 1 deliverable updates.
- Canonical UnifiedEvent TypeScript definitions live in `src/types/unified-event.ts`.
- Progress + issue-level delta log for the latest 10 issues is in `CHANGELOG.md`.

## Documentation

| Document | Description | Phase |
|----------|-------------|-------|
| [docs/architecture.md](docs/architecture.md) | System architecture and service boundaries | Phase 1 |
| [docs/contracts/unified-event.v1.schema.json](docs/contracts/unified-event.v1.schema.json) | UnifiedEvent v1 JSON Schema | Phase 1 |
| [docs/storage.md](docs/storage.md) | Storage model and replayability design | Phase 1 |
| [docs/decision-log.md](docs/decision-log.md) | Architectural decision log | Phase 1 |
| [docs/fixtures.md](docs/fixtures.md) | Canonical fixture library and validation workflow | Phase 1 |
| [docs/test-plan.md](docs/test-plan.md) | Test strategy and acceptance criteria | Phase 1 |
| [CHANGELOG.md](CHANGELOG.md) | Repository status + issue-by-issue change history | Phase 1 |

## UnifiedEvent Types (Issue #9)

`src/types/unified-event.ts` is the compile-time contract for UnifiedEvent v1.

- `TRIGGER_ID` is the source of truth for canonical event-to-trigger mapping.
- `UnifiedEvent` is a discriminated union keyed by `eventType`.
- `EventOf<T>` provides strongly typed narrowing for pipeline/UI switch statements.
- Runtime validation remains schema-driven via AJV (`docs/contracts/unified-event.v1.schema.json`).

### Updating Types When Schema Changes

1. Update `docs/contracts/unified-event.v1.schema.json`.
2. Optionally generate a draft type file for diffing:
   - `npx json-schema-to-typescript docs/contracts/unified-event.v1.schema.json > /tmp/unified-event.generated.d.ts`
3. Reconcile `src/types/unified-event.ts` so payloads, event types, and `TRIGGER_ID` match schema v1.
4. Validate fixtures:
   - `npm run validate-fixtures`
5. Run project checks (lint/type checks) used by your branch before opening a PR.

## Local Development

```bash
npm install
npm run validate-fixtures
npm run audit
```

> Docker Compose stack is planned for Phase 2.

## License

MIT
[contextLink]: AGENTS.prompt.yaml
[projectLink]: https://github.com/users/rainbowkillah/projects/15
