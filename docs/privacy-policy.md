# Privacy and Data Retention Policy — TikTok LIVE Platform

**Owner Agent**: Gemini (AI Agent)
**Depends on**: [docs/storage.md](storage.md), [docs/threat-model.md](threat-model.md)
**Status**: Approved

---

## 1. Principles

This policy defines how the TikTok LIVE Platform handles Personal Identifiable Information (PII) to ensure compliance with modern data protection regulations (such as GDPR).

Our core privacy principles are:
- **Purpose Limitation**: Data is stored exclusively for the purpose of stream analytics, moderation, and rule engine execution.
- **Storage Limitation**: Data is not kept indefinitely unless strictly necessary and anonymized.
- **Data Minimization**: We only collect the fields required by the `UnifiedEvent` schema.
- **Right to Erasure**: Users can request complete deletion of their PII from our platform.

---

## 2. Data Retention Windows

All stored data is subject to the following retention periods, configurable via environment variables per deployment:

| Data Type | Table | Default Retention | Configurable Env Var |
|---|---|---|---|
| Live Events | `events` | 90 days | `EVENT_RETENTION_DAYS` |
| Audit Logs | `actions_log` | 90 days | `ACTIONS_LOG_RETENTION_DAYS` |
| Known Users | `users` | 1 year (inactive) | `USER_RETENTION_DAYS` |
| Stream Metadata | `streams` | 1 year | `STREAM_RETENTION_DAYS` |
| Session Logs | `sessions` | 1 year | `SESSION_RETENTION_DAYS` |
| Rule Definitions | `rules` | Indefinite | N/A (Manual admin only) |

---

## 3. Pruning and Pseudonymization

An automated scheduled job (e.g., cron or pg_cron) enforces the retention policy daily:

### 3.1 Event Pruning
- **Soft Delete**: Events older than `EVENT_RETENTION_DAYS` are soft-deleted (`archived_at = NOW()`).
- **Hard Delete**: Events that have been soft-deleted for 30+ days are permanently hard-deleted from the database.

### 3.2 User Pseudonymization
Users who have not been seen (i.e., `last_seen`) for longer than `USER_RETENTION_DAYS` undergo strong pseudonymization:
1. `display_name` is set to `NULL`.
2. `avatar_url` is set to `NULL`.
3. `tiktok_user_id` and `unique_id` are replaced with a randomly generated cryptographic hash, permanently breaking the link between the user's past actions and their TikTok identity while maintaining referential integrity for statistical analytics.

---

## 4. GDPR Right to Erasure

When a user requests their data be deleted under GDPR (Right to Erasure), a completely automated process must be executed within 30 days.

We provide a dedicated, well-tested script (`scripts/gdpr-erasure.ts`) that accepts a `tiktok_user_id` and performs the following operations:
1. Deletes the corresponding row from the `users` table.
2. Sets `user_id = NULL` for all records in the `events` table matching the user.
3. Scrubs all occurrences of the user's PII (`userId`, `uniqueId`, `displayName`, `avatarUrl`, and chat `message` content) from the `events.event_data` JSONB column.
4. Logs the erasure operation securely into a separate `gdpr_erasures` audit table without storing the original PII.

This ensures all traces of the user are securely and consistently removed from the platform.