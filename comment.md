### Deliverable: Define RBAC model for Moderator vs Streamer UI permissions
* **Title**: RBAC Model Definition
* **Owner Agent**: Gemini (UX, Product & Security Lead)
* **Depends on**: docs/ui-flows.md, docs/threat-model.md, docs/architecture.md
* **Decision log**: 
  - Defined three distinct roles: `STREAMER`, `MODERATOR`, and `VIEWER`.
  - Selected JWT-based authentication where roles and stream scoping (`streamId`) are enforced via token claims.
  - Role-Endpoint Matrix documented to map capabilities to specific endpoints.
  - Rejected complex attribute-based access control (ABAC) in favor of simpler RBAC to expedite Phase 2 delivery while meeting requirements.
* **Open questions**: None at this time.
* **Validation checklist**:
  - [x] Verify `docs/rbac.md` contains the Roles Definition and Role-Endpoint Matrix.
  - [x] Verify `docs/rbac.md` defines JWT claims and Stream-Scoping.
  - [x] Verify `docs/ui-flows.md` Section 1.3 includes Role-Based Access Control UI gating.
  - [x] Verify `docs/threat-model.md` Section 3.6 (E-01, E-02) references `docs/rbac.md`.
  - [x] Verify `docs/architecture.md` Section 3.4 API table includes Auth / Role requirements.

**Review Verdict**:
* ✅ Approved