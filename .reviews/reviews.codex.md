# Codex Peer Review — Issues #1, #2, #3

Date: 2026-02-22  
Reviewer: Codex

## Overall

⚠️ **Approved with required changes**.

The architecture and storage direction are implementable, but the schema and DDL needed a few gaps closed for operational reliability:

1. Add explicit trigger numeric mapping to the UnifiedEvent contract (required by issue #2 checklist).
2. Add proto-field compatibility notes so missing upstream fields have deterministic fallbacks.
3. Add denormalized DB columns required for efficient RAW filtering and replay/rule-engine audits without JSONB-only scans.

## Issue #1 — Service boundaries + Redis Stream contract

✅ **Implementable**. Current boundaries are clean and avoid circular dependencies:

- Ingest writes only `ttlc:raw`
- Normalizer bridges `ttlc:raw` → `ttlc:events`
- Storage Writer is the only persistence writer
- API/rules/forwarder consume only canonical `ttlc:events`

Redis contract is sufficient to implement consumer-group processing with idempotent writes and DLQ fallback.

## Issue #2 — Normalization payload completeness vs proto expectations

⚠️ **Approved with changes**.

Schema was broadly strong, but lacked:

- explicit `triggerId` numeric mapping;
- documented proto fallback expectations for fields that may be absent in different connectors/providers.

These are now added so normalizer behavior is deterministic under proto drift.

## Issue #3 — DDL implementability + missing columns

⚠️ **Approved with changes**.

DDL was implementable, but operationally important columns were missing for scale/debugability:

- `events.raw_type` for RAW event filtering/indexing without deep JSONB traversal.
- `actions_log.stream_id` and `actions_log.session_id` to support replay and per-session rule audit queries.

These are now added with indexes.
