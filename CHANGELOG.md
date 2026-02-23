# Changelog

## 2026-02-23 - Phase 1 Status Snapshot

### Repository status

- Branch `main` is up to date with `origin/main` as of 2026-02-23.
- Worktree contains local, uncommitted Phase 1 deliverable updates.
- Issue `#9` (UnifiedEvent TypeScript definitions) is implemented locally in `src/types/unified-event.ts`.
- Validation checks run locally:
  - `npm run validate-fixtures`: passed (`13/13` fixtures).
  - `npm run audit`: failed due `minimatch <10.2.1` through `@sentry/node` dependency chain.

### Last 10 issues and changes

1. `#18` - `docs/rbac.md` - **OPEN** (implemented locally)
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/18>
   - Local repo change:
     - Created `docs/rbac.md` defining roles (`STREAMER`, `MODERATOR`, `VIEWER`), JWT strategy, and stream-scoping.
     - Updated `docs/architecture.md` with RBAC-informed API table and auth requirements.
     - Updated `docs/ui-flows.md` with role-gated UI component matrix and resolved Open Question 1.
     - Updated `docs/threat-model.md` resolving auth/RBAC-related threats (S-02, S-03, I-04, E-01, E-02).

2. `#10` - `docs/decision-log.md` - **OPEN**
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/10>
   - Local repo change: `docs/decision-log.md` is present and modified with Phase 1 ADR entries (`D-001` to `D-010`).

2. `#9` - `src/types/unified-event.ts` - **OPEN** (implemented locally)
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/9>
   - Local repo change: `src/types/unified-event.ts` now provides:
     - schema-aligned payload interfaces for all canonical event types,
     - `TRIGGER_ID` mapping as a typed source of truth,
     - discriminated union `UnifiedEvent` keyed by `eventType`,
     - `EventOf<T>` extractor for exhaustive switch handling.

3. `#8` - `docs/fixtures.md` - **OPEN**
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/8>
   - Local repo change: `docs/fixtures.md` and all fixture files under `src/fixtures/*.fixture.json` are present and updated.

4. `#7` - `postman/ttlc.postman_collection.json` - **OPEN**
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/7>
   - Local repo change: collection artifacts are present under `postman/collections/`, including `postman/collections/ttlc.postman_collection.json`; environment files under `postman/environments/` are updated.

5. `#6` - `docs/test-plan.md` - **CLOSED** on 2026-02-22
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/6>
   - Local repo change: `docs/test-plan.md` is present and modified.

6. `#5` - `docs/ui-flows.md` - **OPEN**
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/5>
   - Local repo change: `docs/ui-flows.md` is present and modified; UI source files under `ui/src/` are also modified locally.

7. `#4` - `docs/threat-model.md` - **OPEN**
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/4>
   - Local repo change: `docs/threat-model.md` is present and modified.

8. `#3` - `docs/storage.md` - **OPEN**
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/3>
   - Local repo change: `docs/storage.md` is present and modified.

9. `#2` - `docs/contracts/unified-event.v1.schema.json` - **OPEN**
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/2>
   - Local repo change: schema is present at `docs/contracts/unified-event.v1.schema.json`; related fixtures and validation script are in place.

10. `#1` - `docs/architecture.md` - **OPEN**
   - GitHub URL: <https://github.com/rainbowkillah/tiktok-live-platform/issues/1>
   - Local repo change: `docs/architecture.md` exists and remains the architectural source document for Phase 1.

