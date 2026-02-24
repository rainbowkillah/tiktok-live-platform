---
name: 🧪 Test Plan
about: Define structured testing strategy for a milestone or feature
title: "[Test Plan] <feature or milestone>"
labels: tests, qa
assignees: ''
---

# Test Plan

## Scope
What system or milestone is being validated?

---

## Test Categories

### Unit Tests
- Coverage target:
- Framework:
- Critical modules:

### Integration Tests
- Services involved:
- Docker Compose required? (Y/N)
- Fixtures used:

### End-to-End Tests
- User journey:
- Web UI + backend coverage:
- Replay testing included? (Y/N)

### Failure Injection Tests
- Downstream API failure
- Event storm
- Schema mismatch
- Replay corruption

---

## Acceptance Criteria
- [ ] All new code paths tested
- [ ] Replay functionality validated
- [ ] Schema contract validated
- [ ] No regression in CI
- [ ] CI passes consistently

---

## Test Data / Fixtures
- Location:
- Versioning strategy:
- Anonymization applied? (Y/N)

---

## Risks
- 
- 
- 

---

## Reviewer Verdict
- [ ] ✅ Approved
- [ ] ⚠️ Revisions Required
- [ ] ❌ Insufficient Coverage