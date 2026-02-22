/**
 * TypeScript types for UnifiedEvent v1.
 *
 * Aligned with docs/contracts/unified-event.v1.schema.json.
 * Schema version: 1.0.0  |  JSON Schema draft-07
 */

// ---------------------------------------------------------------------------
// Canonical event type enum
// ---------------------------------------------------------------------------

export type EventType =
  | 'CHAT'
  | 'GIFT'
  | 'LIKE'
  | 'FOLLOW'
  | 'SHARE'
  | 'JOIN'
  | 'SUBSCRIBE'
  | 'EMOTE'
  | 'BATTLE'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'ERROR'
  | 'RAW';

// ---------------------------------------------------------------------------
// Trigger ID mapping (stable numeric IDs used by the rule engine)
// ---------------------------------------------------------------------------

export const TRIGGER_ID: Record<EventType, number> = {
  CHAT: 1,
  GIFT: 2,
  LIKE: 3,
  FOLLOW: 4,
  SHARE: 5,
  JOIN: 6,
  SUBSCRIBE: 7,
  EMOTE: 8,
  BATTLE: 9,
  CONNECTED: 10,
  DISCONNECTED: 11,
  ERROR: 12,
  RAW: 13,
};

// ---------------------------------------------------------------------------
// User sub-object
// ---------------------------------------------------------------------------

export interface UnifiedUser {
  /** TikTok numeric user ID (stable). Maps to placeholder {userId}. */
  userId: string;
  /** TikTok @username (may change). Maps to placeholder {username}. */
  uniqueId: string;
  /** Display name / nickname. Maps to placeholder {displayName}. */
  displayName?: string;
  /** URL of the user's profile picture. */
  avatarUrl?: string;
  /** 0 = not following, 1 = following, 2 = friend. */
  followRole?: number;
  /** Whether the user is a moderator in this stream. */
  isModerator?: boolean;
  /** Whether the user is a subscriber to the streamer. */
  isSubscriber?: boolean;
  /** Team member level (0 if not a team member). */
  teamMemberLevel?: number;
}

// ---------------------------------------------------------------------------
// Payload definitions
// ---------------------------------------------------------------------------

export interface ChatPayload {
  /** The chat message text. Maps to placeholder {message}. */
  message: string;
  /** Emotes embedded in the chat message. */
  emotes?: Array<{
    emoteId: string;
    emoteImageUrl?: string;
    placeholderIndex?: number;
  }>;
  /** Detected language code (e.g. 'en', 'zh'). */
  language?: string;
}

export interface GiftPayload {
  /** TikTok numeric gift ID. */
  giftId: number;
  /** Human-readable gift name (e.g. 'Rose'). Maps to placeholder {giftName}. */
  giftName: string;
  /** Number of gifts sent in this event. Maps to placeholder {giftCount}. */
  giftCount: number;
  /** Total coin value (giftCount × unitPrice). Maps to placeholder {coins}. */
  coins: number;
  /** Diamond value (streamer earnings). Typically coins / 2. */
  diamondCount?: number;
  /** Whether the user is currently in a gift streak. */
  streakActive?: boolean;
  /** True on the final event of a gift streak. */
  streakEnd?: boolean;
  /** URL of the gift's image asset. */
  giftImageUrl?: string;
  /** Whether this event is part of a streak (streakActive || streakEnd). */
  isGiftStreak?: boolean;
}

export interface LikePayload {
  /** Number of likes sent in this batch. Maps to placeholder {likeCount}. */
  likeCount: number;
  /** Cumulative total likes for this stream. Maps to placeholder {totalLikeCount}. */
  totalLikeCount: number;
}

/** FOLLOW payload — carries the social sub-type discriminator. */
export interface FollowPayload {
  /** Social sub-type discriminator sourced from WebcastSocialMessage.displayType. */
  displayType: 'pm_mt_msg_viewer_follow';
}

/** SHARE payload — carries the social sub-type discriminator. */
export interface SharePayload {
  /** Social sub-type discriminator sourced from WebcastSocialMessage.displayType. */
  displayType: 'pm_mt_msg_viewer_share';
}

export interface JoinPayload {
  /** Current viewer count at the time of the join event. */
  viewerCount?: number;
  /** TikTok action ID from WebcastMemberMessage. */
  actionId?: number;
}

export interface SubscribePayload {
  /** Subscription month number (1 = first month). */
  subMonth?: number;
}

export interface EmotePayload {
  /** TikTok emote ID. */
  emoteId: string;
  /** URL of the emote image asset. */
  emoteImageUrl?: string;
  /** Emote type string from proto (e.g. 'EMOTETYPENORMAL'). */
  emoteType?: string;
}

export interface BattleParticipant {
  userId?: string;
  uniqueId?: string;
  displayName?: string;
  score?: number;
}

export interface BattlePayload {
  /** TikTok battle/linkmic ID. */
  battleId?: string;
  /** Current phase of the battle. */
  battleStatus?: 'STARTED' | 'UPDATED' | 'ENDED';
  /** Participants in the battle. */
  participants?: BattleParticipant[];
}

export interface ConnectedPayload {
  /** TikTok room ID that was connected. */
  roomId?: string;
  /** Always true for CONNECTED events. */
  isConnected?: true;
  /** Which ingest provider established the connection. */
  provider?: 'direct' | 'euler';
}

export interface DisconnectedPayload {
  /** WebSocket close code. */
  code?: number;
  /** Human-readable disconnect reason. */
  reason?: string;
  /** Whether the ingest service will attempt to reconnect. */
  willReconnect?: boolean;
}

export interface ErrorPayload {
  /** Error message. */
  message: string;
  /** Error code (e.g. 'USER_OFFLINE', 'INVALID_RESPONSE'). */
  code?: string;
  /** Stack trace (only in development/debug mode). */
  stack?: string;
}

export interface RawPayload {
  /** Original WebcastEvent or proto type name. */
  rawType: string;
  /** Raw decoded event data as-is from tiktok-live-connector. */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Discriminated union for typed event payload
// ---------------------------------------------------------------------------

export type UnifiedPayload =
  | ChatPayload
  | GiftPayload
  | LikePayload
  | FollowPayload
  | SharePayload
  | JoinPayload
  | SubscribePayload
  | EmotePayload
  | BattlePayload
  | ConnectedPayload
  | DisconnectedPayload
  | ErrorPayload
  | RawPayload;

// ---------------------------------------------------------------------------
// Core UnifiedEvent envelope
// ---------------------------------------------------------------------------

export interface UnifiedEvent {
  /** Schema version — always '1' for v1 events. */
  schemaVersion: '1';
  /**
   * Dedupe key: SHA-256 hex digest of
   * (streamId + ':' + sessionId + ':' + seqNo + ':' + rawType).
   */
  eventId: string;
  /** Canonical event type. */
  eventType: EventType;
  /** Numeric trigger ID for the rule engine dispatch path. */
  triggerId: number;
  /** TikTok room ID (numeric string). */
  streamId: string;
  /** Internal session UUID. One session = one connect attempt or replay run. */
  sessionId: string;
  /** ISO 8601 UTC timestamp of the event on TikTok's side. */
  timestamp: string;
  /** ISO 8601 UTC timestamp of when the ingest service received the event. */
  ingestedAt?: string;
  /** 'live' or 'replay'. */
  source: 'live' | 'replay';
  /** Sequence number from TikTok's WebSocket frame. */
  seqNo?: number;
  /** TikTok user who triggered this event. */
  user: UnifiedUser;
  /** Event-type-specific data. */
  payload?: UnifiedPayload;
}

// ---------------------------------------------------------------------------
// Typed helper — narrow payload by event type
// ---------------------------------------------------------------------------

export type EventOf<T extends EventType> = UnifiedEvent & {
  eventType: T;
  triggerId: (typeof TRIGGER_ID)[T];
  payload: T extends 'CHAT'
    ? ChatPayload
    : T extends 'GIFT'
      ? GiftPayload
      : T extends 'LIKE'
        ? LikePayload
        : T extends 'FOLLOW'
          ? FollowPayload
          : T extends 'SHARE'
            ? SharePayload
            : T extends 'JOIN'
              ? JoinPayload
              : T extends 'SUBSCRIBE'
                ? SubscribePayload
                : T extends 'EMOTE'
                  ? EmotePayload
                  : T extends 'BATTLE'
                    ? BattlePayload
                    : T extends 'CONNECTED'
                      ? ConnectedPayload
                      : T extends 'DISCONNECTED'
                        ? DisconnectedPayload
                        : T extends 'ERROR'
                          ? ErrorPayload
                          : T extends 'RAW'
                            ? RawPayload
                            : never;
};
