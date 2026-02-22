# Threat Model — TikTok LIVE Platform

**Owner Agent**: Gemini (AI Agent)
**Depends on**: [docs/architecture.md](architecture.md), [docs/contracts/unified-event.v1.schema.json](contracts/unified-event.v1.schema.json), [docs/storage.md](storage.md)
**GitHub Issue**: [#4](https://github.com/rainbowkillah/tiktok-live-platform/issues/4)
**Status**: Draft — Pending peer review

---

## 1. Introduction

This document outlines the threat model for the TikTok LIVE Platform. Its purpose is to identify, analyze, and propose mitigations for potential security threats to the system. The model follows the **STRIDE** framework, which categorizes threats into Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, and Elevation of Privilege.

This is a living document and will be updated as the platform evolves.

---

## 2. System Overview & Trust Boundaries

The system ingests events from TikTok's LIVE service, normalizes them, and exposes them to various consumers. The high-level data flow is as follows:

```
[TikTok LIVE] → [1. Ingest] → [2. Normalizer] → [Redis Streams] → [3. Storage/API/Rules/Forwarder] → [4. UI/Downstream]
```

We can identify the following trust boundaries:

*   **B1: TikTok LIVE → Ingest Service**: The boundary between TikTok's external service and our platform. We have no control over the data sent from TikTok.
*   **B2: Internal Services (Ingest, Normalizer, API, etc.)**: The boundary between the services within our platform. These services run in a trusted environment (e.g., Docker network).
*   **B3: API Service → Web UI**: The boundary between our backend API and the client-side UI running in a user's browser.
*   **B4: Platform → External Systems**: The boundary for any outbound connections, such as the Streamer Forwarder or webhook actions from the Rule Engine.

---

## 3. Threat Analysis (STRIDE)

| Threat Category | Threat Scenario | Attack Surface / Trust Boundary | Mitigation | Residual Risk |
|---|---|---|---|---|
| **S**poofing | Attacker spoofs a TikTok user's identity to send malicious chat messages or trigger rules. | **B1** (Ingest) | The `ingest` service relies on `tiktok-live-connector` which handles the authenticated session with TikTok. We are trusting the library to correctly attribute events to users. We should ensure we are using a pinned and vetted version of the library. | Medium. A vulnerability in `tiktok-live-connector` could lead to user spoofing. |
| | Attacker spoofs a service within the platform (e.g., pretends to be the `normalizer`). | **B2** (Internal) | Run all internal services on a private network (e.g., Docker network). Use service-to-service authentication (e.g., mTLS) in a production environment (Phase 4+). | Low. |
| **T**ampering | Attacker intercepts and modifies event data in transit from TikTok to the `ingest` service. | **B1** (Ingest) | The connection to TikTok LIVE is over WebSocket (WSS), which is encrypted. | Low. |
| | Attacker modifies event data in the Redis Streams. | **B2** (Internal) | Access to Redis should be restricted to the internal services. Use Redis authentication. | Low. |
| | Attacker modifies data in the PostgreSQL database directly. | **B2** (Internal) | Access to the database should be restricted with strong credentials. The append-only nature of the `events` table provides some protection against tampering. | Low. |
| | A user modifies a rule to perform an unauthorized action. | **B3** (API) | The API must have proper authorization checks to ensure that only authenticated users with the correct permissions can create or modify rules. | Low. |
| **R**epudiation | A user denies sending a specific chat message or gift. | **N/A** | The platform logs all events with the associated user ID from TikTok. This provides a strong audit trail. The `eventId` provides a unique identifier for each event. | Low. |
| **I**nformation Disclosure | PII (user IDs, display names, chat messages) is exposed to unauthorized parties. | **B2, B3** | Implement strict access controls on the API. Encrypt data at rest (database) and in transit (TLS for API). Follow the GDPR retention and erasure policies outlined in `storage.md`. | Medium. The risk of data leaks always exists. The mitigations reduce the likelihood and impact. |
| | Leaking of secrets (`SESSION_ID`, `DATABASE_URL`, `EULER_API_KEY`). | **N/A** | Follow secret management best practices (e.g., no hardcoded secrets, use a secret manager like Vault or cloud provider services). | Low. |
| | An error message leaks sensitive information (e.g., stack trace). | **B3** (API) | The `ErrorPayload` in the `UnifiedEvent` schema includes a `stack` field. This should only be populated in development/debug mode and not sent to the UI in production. | Low. |
| **D**enial of Service | The `ingest` service is overwhelmed by a flood of events from a single stream. | **B1** (Ingest) | The `ingest` service should have rate limiting and backpressure mechanisms. The `tiktok-live-connector` library may have its own limits. | Medium. A large-scale bot attack could still cause issues. |
| | A malicious rule creates an infinite loop or a high-volume of actions. | **B2, B3** (Rules) | The rule engine should have built-in limits on the number of actions that can be triggered by a single event or over a period of time. | Medium. A poorly written rule could still cause performance issues. |
| | The database is overloaded with queries or writes. | **B2** (Internal) | Use connection pooling and optimize queries. The `MAXLEN` on Redis Streams provides a buffer. | Low. |
| **E**levation of Privilege | A regular user gains moderator privileges in the UI. | **B3** (API, UI) | A robust authentication and authorization model is needed. The API must enforce permissions for all actions. The UI should only show moderator controls to authorized users. | High (if not mitigated). This is a critical area to get right. |
| | A user creates a rule with an action they are not authorized to perform (e.g., a webhook to an internal service). | **B3** (API) | The rule engine must have a strict allowlist for webhook destinations to prevent SSRF attacks. The API must validate the action type and parameters when a rule is created. | Medium. A misconfiguration could lead to vulnerabilities. |

---

## 4. Mitigations & Next Steps

Based on the threat analysis, the following are key areas to focus on for security:

*   **Authentication & Authorization:** A robust authentication and authorization model is the highest priority. This needs to be designed and implemented for the API and UI to address the "Elevation of Privilege" threats. **(Open Question)**
*   **Secret Management:** A proper secret management solution should be used from the start.
*   **Input Validation:** All input from external sources (TikTok API, user input in UI) must be sanitized and validated.
*   **Rate Limiting:** Implement rate limiting at the API and ingest layers.
*   **Rule Engine Hardening:** The rule engine needs to be carefully designed to prevent abuse, especially for webhook actions.
*   **Dependency Management:** Keep dependencies like `tiktok-live-connector` up to date and monitor them for vulnerabilities.
*   **GDPR Compliance:** Fully implement the GDPR retention and erasure policies as discussed in the `storage.md` review.

---

## 5. Residual Risks & Open Questions

*   The platform's security is dependent on the security of `tiktok-live-connector`. A vulnerability in this library could have a significant impact.
*   The full authentication and authorization model is still an open question.
*   The exact mechanism for real-time monitoring and response to abuse is yet to be defined.

This threat model provides a baseline for the security of the platform. It should be reviewed and updated as the development progresses.
