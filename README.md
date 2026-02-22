# TikTok LIVE Platform

Production-ready event platform for ingesting, normalizing, storing, and acting on TikTok LIVE stream events.

> **Status**: Phase 1 — Discovery & Planning
> **Github Project**:[Project Roadmap](https://github.com/users/rainbowkillah/projects/15/views/1)
                    :[Project Board](https://github.com/users/rainbowkillah/projects/15/views/2)
                    :[Project Table](https://github.com/users/rainbowkillah/projects/15/views/3)
## Overview

This platform wraps [`tiktok-live-connector`](https://www.npmjs.com/package/tiktok-live-connector) as its ingestion layer and adds:

- A normalization pipeline mapping TikTok events → **UnifiedEvent v1**
- An append-only event store (PostgreSQL)
- A real-time event bus (Redis Streams)
- A REST + SSE/WebSocket API for downstream consumers
- A Web UI for streamers and moderators
- A rule engine with template rendering and action execution
- A streamer forwarder with retry/back-off and dead-letter queue

## Documentation

| Document | Description | Phase |
|----------|-------------|-------|
| [docs/architecture.md](docs/architecture.md) | System architecture and service boundaries | Phase 1 |
| [docs/contracts/unified-event.v1.schema.json](docs/contracts/unified-event.v1.schema.json) | UnifiedEvent v1 JSON Schema | Phase 1 |
| [docs/storage.md](docs/storage.md) | Storage model and replayability design | Phase 1 |
| [docs/decision-log.md](docs/decision-log.md) | Architectural decision log | Phase 1 |

## Local Development

> Docker Compose stack coming in Phase 2.

## License

MIT
[contextLink]: AGENTS.prompt.yaml
[projectLink]: https://github.com/users/rainbowkillah/projects/15