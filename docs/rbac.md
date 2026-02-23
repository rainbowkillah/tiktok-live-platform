# RBAC Model — TikTok LIVE Platform

**Owner Agent**: Gemini (UX, Product & Security Lead)
**Status**: Draft
**Depends on**: [docs/architecture.md](architecture.md), [docs/ui-flows.md](ui-flows.md), [docs/threat-model.md](threat-model.md)

---

## 1. Overview

The TikTok LIVE Platform employs a Role-Based Access Control (RBAC) model to ensure that users have the minimum necessary permissions to perform their tasks. This model mitigates risks related to unauthorized moderation, rule tampering, and information disclosure.

## 2. Roles Definition

| Role | Description | Target User |
|------|-------------|-------------|
| `STREAMER` | The owner of the stream. Has full administrative control over all settings, rules, and data. | Content Creators |
| `MODERATOR` | Staff members who assist in managing the live stream. Can monitor events and take moderation actions but cannot change system-wide configurations or rules. | Channel Moderators |
| `VIEWER` | Authenticated users who can view public analytics or historical data but have no moderation or administrative privileges. | Viewers / Fans |

## 3. Role-Endpoint Matrix

All state-mutating endpoints and sensitive data feeds require authentication and specific roles.

| Service Area | Endpoint / Action | STREAMER | MODERATOR | VIEWER |
|--------------|-------------------|:---:|:---:|:---:|
| **Live Feed** | `GET /streams/:id/events` (SSE) | ✅ | ✅ | ❌ |
| **Moderation**| `POST /users/:id/notes` | ✅ | ✅ | ❌ |
| **Moderation**| `POST /actions/timeout` | ✅ | ✅ | ❌ |
| **Rules** | `GET /rules` | ✅ | ✅ | ❌ |
| **Rules** | `POST /rules` (Create) | ✅ | ❌ | ❌ |
| **Rules** | `PUT /rules/:id` (Edit) | ✅ | ❌ | ❌ |
| **Rules** | `DELETE /rules/:id` | ✅ | ❌ | ❌ |
| **Rules** | `POST /rules/test` | ✅ | ✅ | ❌ |
| **Replay** | `POST /sessions/:id/replay` | ✅ | ❌ | ❌ |
| **Analytics** | `GET /analytics` | ✅ | ✅ | ✅ (Limited) |
| **History** | `GET /sessions/:id/events` | ✅ | ✅ | ✅ |
| **System** | `GET /health` | ✅ | ✅ | ✅ |

## 4. Authentication & Authorization Strategy

### 4.1 JWT Claims

The platform uses JWTs for session management. The following claims are mandatory for RBAC:

- `sub`: The unique ID of the authenticated user.
- `role`: One of `STREAMER`, `MODERATOR`, or `VIEWER`.
- `streamId`: The ID of the stream the user is authorized to access (for `STREAMER` and `MODERATOR` roles).

Example JWT payload:
```json
{
  "sub": "user_123456",
  "role": "MODERATOR",
  "streamId": "7331234567890",
  "iat": 1708650000,
  "exp": 1708686000
}
```

### 4.2 Stream-Scoping

Authorization is strictly enforced to ensure a user with a `MODERATOR` role for `streamA` cannot access or take actions on `streamB`. The `streamId` claim in the JWT must match the `:id` parameter in the API request path.

## 5. UI Component Gating

The Web UI must conditionally render or disable components based on the user's role.

| Component | STREAMER | MODERATOR | VIEWER |
|-----------|:---:|:---:|:---:|
| **Event Feed** | Visible | Visible | Hidden |
| **Rule List** | Full Edit | View + Test | Hidden |
| **"New Rule" Button** | Visible | Hidden | Hidden |
| **Moderation Panel** | Enabled | Enabled | Hidden |
| **Replay Controls** | Enabled | View-only | Hidden |
| **Analytics Dashboard** | Full | Full | Aggregate Only |

## 6. Security Mitigations

This RBAC model directly addresses several threats identified in [docs/threat-model.md](threat-model.md):

- **E-01 (Unauthorized Rule Creation)**: Mitigated by restricting `POST /rules` to `STREAMER` role only.
- **E-02 (Unauthorized Moderation)**: Mitigated by requiring `MODERATOR` or `STREAMER` role for moderation actions and enforcing stream-scoping.
- **E-06 (Elevation of Privilege)**: Mitigated by strict role checking in the API middleware and the use of least-privilege DB users for different service components.
