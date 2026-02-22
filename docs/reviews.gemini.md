# Gemini Peer Review — Architecture & Storage

**Reviewer**: Gemini (UX, Product & Security Lead)
**Date**: 2026-02-22
**Documents**: [docs/architecture.md](architecture.md), [docs/storage.md](storage.md)

---

## Overall

⚠️ **Approved with required changes**.

The architecture and storage design are solid, but there are a few UX and Security gaps that need to be addressed before moving to Phase 2 implementation.

## Architecture Review (docs/architecture.md)

**Verdict**: ⚠️ Approved with changes

### UX Implications
- **SSE Connection Limits**: The architecture specifies an SSE endpoint for the live feed. For high-volume streams, client-side buffering and virtualized lists (defined in `ui-flows.md`) are necessary. The API must also implement SSE backpressure or max connection limits to prevent degraded UX or DoS.

### Security Implications
- **Missing Authentication for State-Mutating Endpoints**: The document lists `POST /rules`, `PUT /rules/:id`, `DELETE /rules/:id`, and `POST /sessions/:id/replay` without mentioning authentication. These endpoints *must* be secured to prevent unauthorized rule creation and replay triggering.
- **Rate Limiting**: The architecture should explicitly require rate limiting on the API service to mitigate DoS attacks (Threat D-04).

**Required Changes**:
1. Update Section 3.4 (API Service) to explicitly state that state-mutating endpoints and SSE connections require authentication.
2. Add API rate limiting to the Risk Register or Service responsibilities.

## Storage Review (docs/storage.md)

**Verdict**: ⚠️ Approved with changes

### Privacy & Retention
The storage design shows a good initial effort in considering GDPR and privacy. However, to be sufficient, the following changes are required:
- **Define Retention for All PII-related Tables**: The "Indefinite" retention policy for the `users`, `streams`, and `sessions` tables is a major GDPR concern. Update these to a 1-year retention limit.
- **Strengthen Pseudonymization**: Nulling `avatar_url` and `display_name` is good, but continued storage of `tiktok_user_id` and `unique_id` is insufficient. Replace these identifiers with a randomly generated value or a hash during pruning.
- **Automate GDPR Erasure Requests**: Formalize the manual admin operation into a well-tested, automated script (`scripts/gdpr-erasure.ts`) that handles scrubbing `events.event_data` JSONB consistently.
- **Consolidate Privacy Documentation**: The full data retention and privacy policy should be consolidated into a single, comprehensive document (`docs/privacy-policy.md`).

**Required Changes**:
1. Update `storage.md` with the new 1-year retention rules and stronger pseudonymization logic.
2. Draft `privacy-policy.md` containing the consolidated GDPR and data retention policies.
3. Update `threat-model.md` to reference the consolidated privacy policy.
