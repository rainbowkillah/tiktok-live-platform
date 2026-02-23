---
name: 🧠 Architecture / System Design
about: Define system-level architecture or major design change
title: "[Architecture] <component or system>"
labels: architecture
assignees: ''
---

# Architecture Document

## Goal
What are we designing?

---

## System Overview
Describe high-level architecture:
- Ingest
- Normalizer
- Event Bus
- Rule Engine
- Storage
- Replay
- Forwarder
- Web UI

---

## Data Flow Diagram
(Insert diagram or link)

---

## UnifiedEvent Contract Alignment
- Version:
- Trigger-ID mapping defined? (Y/N)
- Placeholder strategy defined? (Y/N)

---

## Storage Model
- Tables:
- Indexing strategy:
- Replay strategy:
- Aggregation strategy:

---

## Deployment Model
- Local-first Docker Compose? (Y/N)
- Cloud target:
- Scaling considerations:

---

## Observability Plan
- Logging
- Metrics
- Alerting

---

## Security Considerations
- Secrets handling
- Rate limiting
- Data retention
- Threat surface

---

## Risks
- 
- 
- 

---

## Review Checklist
- [ ] Contract defined
- [ ] Replay supported
- [ ] Storage schema documented
- [ ] Threat model considered
- [ ] CI/testability impact assessed

---

## Reviewer Verdict
- [ ] ✅ Approved
- [ ] ⚠️ Approved with changes
- [ ] ❌ Rejected