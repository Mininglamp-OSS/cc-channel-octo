// Forked from openclaw-channel-octo v1.0.13 (2026-06-04)
// Source: https://github.com/Mininglamp-OSS/openclaw-channel-octo

/** Octo Bot API types. */

export interface BotRegisterResp {
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}

export interface BotMessage {
  message_id: string;
  message_seq: number;
  from_uid: string;
  from_name?: string;
  channel_id?: string;
  channel_type?: ChannelType;
  timestamp: number;
  payload: MessagePayload;
  /** True when this message is part of a streaming sequence (WuKongIM settingByte bit 1). */
  streamOn?: boolean;
}

/**
 * 单个 mention 的精确位置描述。
 * offset/length 的单位为 UTF-16 code units（与 JS string.length 一致）。
 */
export interface MentionEntity {
  /** 被 @ 用户的唯一标识符 */
  uid: string;
  /** @name 在 content 中的起始位置（包括 @ 符号） */
  offset: number;
  /** @name 的完整长度（包括 @ 符号） */
  length: number;
}

export interface MentionPayload {
  uids?: string[];
  entities?: MentionEntity[];
  /**
   * Legacy "@all" flag. Server outbound double-writes this for legacy clients
   * even after the three-state split landed (server-side semantic: all=humans).
   * Adapter treats `all=1` as a humans-only signal (NOT ais) to match the
   * server's authoritative decision.
   */
  all?: boolean | number;
  /**
   * Three-state mention (server-authoritative, PR-A landed on octo-server #94).
   * `humans=1` → "@所有人", `ais=1` → "@所有AI". Both can co-exist.
   * Adapter only reads these; it never decides semantics — server is the
   * source of truth and rewrites legacy `all=1` into the canonical form
   * before adapter sees it.
   */
  humans?: boolean | number;
  ais?: boolean | number;
}

export interface ReplyPayload {
  payload?: MessagePayload;
  from_uid?: string;
  from_name?: string;
}

export interface MessagePayload {
  type: MessageType;
  content?: string;
  url?: string;
  name?: string;
  mention?: MentionPayload;
  reply?: ReplyPayload;
  event?: {
    type: string;
    version?: number;
    updated_by?: string;
    group_no?: string;
    short_id?: string;
  };
  [key: string]: unknown;
}

export interface SendMessageResult {
  message_id: string;  // string due to int64 protection in postJson
  client_msg_no: string;
  message_seq: number;
}

// ─── Stream API (OCT-31 / OCT-37) ───────────────────────────────────────────
//
// Re-introduced after b7139d2 removed the (then-dead) stream path. The server
// now exposes /v1/bot/stream/{start,end} (OCT-31). The bot opens a live bubble
// with stream/start, streams incremental chunks via /v1/bot/sendMessage with
// `stream_no` set, and closes the bubble with stream/end (terminal END). The
// server forces FromUID to the authenticated bot, so no sender field is sent.

/** Request body for POST /v1/bot/stream/start. */
export interface BotStreamStartReq {
  channel_id: string;
  channel_type: ChannelType;
  /** Optional client-side idempotency key for the opening message. */
  client_msg_no?: string;
  /** Optional message header flags (e.g. red-dot). */
  header?: Record<string, unknown>;
  /** Optional base64-encoded initial payload. */
  payload?: string;
}

/** Response body for POST /v1/bot/stream/start. */
export interface BotStreamStartResp {
  stream_no: string;
}

/** Request body for POST /v1/bot/stream/end. */
export interface BotStreamEndReq {
  stream_no: string;
  channel_id: string;
  channel_type: ChannelType;
}

/** Channel types */
export enum ChannelType {
  DM = 1,
  Group = 2,
  CommunityTopic = 5,
}

/** Message content types */
export enum MessageType {
  Text = 1,
  Image = 2,
  GIF = 3,
  Voice = 4,
  Video = 5,
  Location = 6,
  Card = 7,
  File = 8,
  MultipleForward = 11,
  /** Rich text (text + inline images), introduced in upstream v1.0.x */
  RichText = 14,
}

/**
 * RichText(=14) block type constants.
 *
 * Wire format from upstream uses strings ("text" / "image"), matching the
 * server's RichTextBlockText / RichTextBlockImage tags from octo-lib.
 */
export const RICH_TEXT_BLOCK_TEXT = "text";
export const RICH_TEXT_BLOCK_IMAGE = "image";

/** Placeholder rendered for an inline image when assembling plain text. */
export const RICH_TEXT_IMAGE_PLACEHOLDER = '[图片]';

// ─── Forward-payload nested message (MultipleForward children) ──────────────

export interface ForwardUser {
  uid: string;
  name: string;
}

export interface ForwardMessage {
  message_id?: string;
  from_uid: string;
  timestamp?: number;
  payload: {
    type: number;
    content?: string;
    url?: string;
    name?: string;
    users?: ForwardUser[];
    msgs?: ForwardMessage[];
  };
}

