// Forked from openclaw-channel-octo v1.0.13 (2026-06-04)
// Source: https://github.com/Mininglamp-OSS/openclaw-channel-octo
// Removed: COS upload, GROUP.md API, OBO, rich text, media, thread/group management,
//          read receipts, bot groups list, group info, mention prefs, space members.

import {
  ChannelType,
  MessageType,
  type MentionEntity,
  type RichTextBlock,
  type SendMessageResult,
} from "./types.js";
import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Maximum base64-encoded payload length accepted from /v1/bot/messages/sync.
 * D1/S7 (齐 P0-2): a malicious or buggy server could return a single payload
 * of arbitrary size; Buffer.from(str, 'base64') allocates ~0.75 × input bytes
 * synchronously. Cap at 256 KiB base64 ≈ 192 KiB decoded — well above any
 * legitimate IM message payload.
 */
const MAX_HISTORICAL_PAYLOAD_BASE64_LEN = 256 * 1024;

/**
 * Generate a client-side idempotency key (UUID) for outbound messages.
 *
 * WuKongIM uses client_msg_no for server-side dedup — identical client_msg_no
 * values result in only one stored message.
 */
export function generateClientMsgNo(): string {
  return randomUUID();
}

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
};

/**
 * Parse JSON with int64 message_id protection.
 * Converts 16+ digit numeric message_id values to strings before JSON.parse
 * to prevent JavaScript precision loss for IDs exceeding Number.MAX_SAFE_INTEGER.
 */
function parseOctoJson<T>(text: string): T {
  const safeText = text.replace(
    /"message_id"\s*:\s*(\d{16,})/g,
    '"message_id":"$1"',
  );
  return JSON.parse(safeText) as T;
}

export async function postJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(payload),
    signal: effectiveSignal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${response.status}): ${text || response.statusText}`);
  }

  const text = await response.text();
  if (!text) return undefined;
  try {
    return parseOctoJson<T>(text);
  } catch {
    throw new Error(`Octo API ${path} returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

// ─── Message Sending ────────────────────────────────────────────────────────

export async function sendMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  content: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  replyMsgId?: string;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  const payload: Record<string, unknown> = {
    type: MessageType.Text,
    content: params.content,
  };
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    if (params.mentionAll) {
      mention.all = 1;
    }
    payload.mention = mention;
  }
  if (params.replyMsgId) {
    payload.reply = { message_id: params.replyMsgId };
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
  }, params.signal);
}

/**
 * Send a media message (Image / GIF / Voice / Video / File).
 *
 * Uses the same /v1/bot/sendMessage endpoint as text — the payload `type`
 * field selects the media kind. Image needs width/height/name/size; File-like
 * types (File/Voice/Video) need name/size only.
 *
 * Caller is responsible for uploading the file to COS first and passing the
 * resulting CDN URL via `params.url`. See media-upload.ts uploadAndSendMedia().
 */
export async function sendMediaMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  type: MessageType;
  url: string;
  name?: string;
  size?: number;
  width?: number;
  height?: number;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  const payload: Record<string, unknown> = {
    type: params.type,
    url: params.url,
  };
  // Image (type=2) needs width/height/name/size; File-like (8/4/5) needs name/size only.
  if (params.type === MessageType.Image) {
    if (params.width) payload.width = params.width;
    if (params.height) payload.height = params.height;
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  } else {
    if (params.name) payload.name = params.name;
    if (params.size != null) payload.size = params.size;
  }
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0)
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    payload.mention = mention;
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
  }, params.signal);
}

/**
 * Send a RichText(=14) message — text and image blocks interleaved in a single payload.
 *
 * Replaces "sendMessage(text) + N sendMediaMessage(image)" with a single HTTP send.
 * Block contract (octo-lib richtext.go): `text` blocks need non-empty text;
 * `image` blocks need http(s) URL + width/height > 0. Server validates;
 * this function only assembles.
 *
 * `plain` (optional): downgrade text for legacy clients. Server recomputes from
 * blocks authoritatively, so passing plain is purely for old-client compat.
 */
export async function sendRichTextMessage(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  blocks: RichTextBlock[];
  plain?: string;
  mentionUids?: string[];
  mentionEntities?: MentionEntity[];
  mentionAll?: boolean;
  clientMsgNo?: string;
  signal?: AbortSignal;
}): Promise<SendMessageResult | undefined> {
  const payload: Record<string, unknown> = {
    type: MessageType.RichText,
    content: params.blocks,
  };
  if (typeof params.plain === "string") {
    payload.plain = params.plain;
  }
  if (
    (params.mentionUids && params.mentionUids.length > 0) ||
    (params.mentionEntities && params.mentionEntities.length > 0) ||
    params.mentionAll
  ) {
    const mention: Record<string, unknown> = {};
    if (params.mentionUids && params.mentionUids.length > 0) {
      mention.uids = params.mentionUids;
    }
    if (params.mentionEntities && params.mentionEntities.length > 0) {
      mention.entities = params.mentionEntities;
    }
    if (params.mentionAll) {
      mention.all = 1;
    }
    payload.mention = mention;
  }
  return await postJson<SendMessageResult>(params.apiUrl, params.botToken, "/v1/bot/sendMessage", {
    channel_id: params.channelId,
    channel_type: params.channelType,
    payload,
    client_msg_no: params.clientMsgNo ?? generateClientMsgNo(),
  }, params.signal);
}

/**
 * Get STS temporary credentials for direct COS upload.
 * GET /v1/bot/upload/credentials?filename=<encoded>
 *
 * Returns short-lived (typically 1h) credentials scoped to a single key.
 * Used by uploadAndSendMedia in media-upload.ts.
 */
export async function getUploadCredentials(params: {
  apiUrl: string;
  botToken: string;
  filename: string;
  signal?: AbortSignal;
}): Promise<{
  bucket: string;
  region: string;
  key: string;
  credentials: {
    tmpSecretId: string;
    tmpSecretKey: string;
    sessionToken: string;
  };
  startTime: number;
  expiredTime: number;
  cdnBaseUrl?: string;
}> {
  const base = params.apiUrl.replace(/\/+$/, "");
  const url = `${base}/v1/bot/upload/credentials?filename=${encodeURIComponent(params.filename)}`;
  const effectiveSignal = params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: effectiveSignal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // P1 from PR#34 review: server may echo request headers (incl. Authorization
    // bearer token) on some error responses. Cap at 200 chars and strip any
    // "Authorization" / "Bearer" tokens defensively before surfacing.
    const sanitized = text
      .slice(0, 200)
      .replace(/Bearer\s+\S+/gi, "Bearer ***")
      .replace(/(authorization"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1***");
    throw new Error(`Octo API /v1/bot/upload/credentials failed (${response.status}): ${sanitized || response.statusText}`);
  }
  const data = await response.json() as Record<string, unknown>;
  // Validate required fields to catch backend API changes early.
  const missing = ['bucket', 'region', 'key', 'credentials'].filter(k => !data[k]);
  if (missing.length > 0) {
    throw new Error(`Octo API /v1/bot/upload/credentials returned incomplete response: missing ${missing.join(', ')}`);
  }
  const creds = data.credentials as Record<string, unknown>;
  if (!creds.tmpSecretId || !creds.tmpSecretKey || !creds.sessionToken) {
    throw new Error("Octo API /v1/bot/upload/credentials returned incomplete credentials");
  }
  return data as {
    bucket: string;
    region: string;
    key: string;
    credentials: { tmpSecretId: string; tmpSecretKey: string; sessionToken: string; };
    startTime: number;
    expiredTime: number;
    cdnBaseUrl?: string;
  };
}

// ─── Typing / Heartbeat ─────────────────────────────────────────────────────

export async function sendTyping(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/typing", {
    channel_id: params.channelId,
    channel_type: params.channelType,
  }, params.signal);
}

export async function sendHeartbeat(params: {
  apiUrl: string;
  botToken: string;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, "/v1/bot/heartbeat", {}, params.signal);
}

// ─── Bot Registration ───────────────────────────────────────────────────────

export async function registerBot(params: {
  apiUrl: string;
  botToken: string;
  forceRefresh?: boolean;
  agentPlatform?: string;
  agentVersion?: string;
  signal?: AbortSignal;
}): Promise<{
  robot_id: string;
  im_token: string;
  ws_url: string;
  api_url: string;
  owner_uid: string;
  owner_channel_id: string;
}> {
  const path = params.forceRefresh
    ? "/v1/bot/register?force_refresh=true"
    : "/v1/bot/register";
  const body: Record<string, string> = {};
  if (params.agentPlatform) body.agent_platform = params.agentPlatform;
  if (params.agentVersion) body.agent_version = params.agentVersion;
  const result = await postJson<{
    robot_id: string;
    im_token: string;
    ws_url: string;
    api_url: string;
    owner_uid: string;
    owner_channel_id: string;
  }>(params.apiUrl, params.botToken, path, body, params.signal);
  if (!result) throw new Error("Octo bot registration returned empty response");
  return result;
}

/**
 * GET request helper with consistent error handling, timeout, and int64 protection.
 */
async function getJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
    signal: effectiveSignal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  const text = await resp.text();
  if (!text) return {} as T;
  return parseOctoJson<T>(text);
}

// ─── Read Receipt ──────────────────────────────────────────────────────────

export async function sendReadReceipt(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  messageIds: string[];
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(params.apiUrl, params.botToken, '/v1/bot/readReceipt', {
    channel_id: params.channelId,
    channel_type: params.channelType,
    message_ids: params.messageIds,
  }, params.signal);
}

// ─── Group Members ──────────────────────────────────────────────────────────

export interface GroupMember {
  uid: string;
  name: string;
  role: number;
  robot?: number;
  status?: number;
  [key: string]: unknown;
}

export async function getGroupMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
}): Promise<GroupMember[]> {
  const data = await getJson<Record<string, unknown>>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${params.groupNo}/members`,
  );
  const members = Array.isArray(data?.members)
    ? data.members
    : Array.isArray(data)
      ? data
      : [];
  return members as GroupMember[];
}



// ─── User Info ──────────────────────────────────────────────────────────────

export async function fetchUserInfo(params: {
  apiUrl: string;
  botToken: string;
  uid: string;
}): Promise<{ uid: string; name: string; avatar?: string } | null> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/user/info?uid=${encodeURIComponent(params.uid)}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${params.botToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status === 404) {
      return null;
    }
    if (!resp.ok) {
      console.error(`octo: fetchUserInfo(${params.uid}) failed: ${resp.status}`);
      return null;
    }
    const data = await resp.json() as { uid?: string; name?: string; avatar?: string };
    if (data?.name) {
      return { uid: data.uid ?? params.uid, name: data.name, avatar: data.avatar };
    }
    return null;
  } catch (err) {
    console.error(`octo: fetchUserInfo(${params.uid}) error: ${String(err)}`);
    return null;
  }
}

// ─── Bot Groups ─────────────────────────────────────────────────────────────

export interface BotGroup {
  group_no: string;
  name: string;
  [key: string]: unknown;
}

/** Fetch the list of groups the bot has joined. */
export async function fetchBotGroups(params: {
  apiUrl: string;
  botToken: string;
}): Promise<BotGroup[]> {
  try {
    const data = await getJson<BotGroup[]>(
      params.apiUrl,
      params.botToken,
      "/v1/bot/groups",
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`octo: fetchBotGroups failed: ${String(err)}`);
    return [];
  }
}

// ─── Group Info ─────────────────────────────────────────────────────────────

export interface GroupInfo {
  group_no: string;
  name: string;
  owner_uid?: string;
  member_count?: number;
  [key: string]: unknown;
}

/** Fetch detailed info for a single group. */
export async function getGroupInfo(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
}): Promise<GroupInfo> {
  return await getJson<GroupInfo>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${params.groupNo}`,
  );
}

// ─── Space Member Search ────────────────────────────────────────────────────

export interface SpaceMember {
  uid: string;
  name: string;
  robot: number;
  [key: string]: unknown;
}

/** Search members in the bot's Space by keyword. */
export async function searchSpaceMembers(params: {
  apiUrl: string;
  botToken: string;
  keyword?: string;
  spaceId?: string;
  limit?: number;
}): Promise<SpaceMember[]> {
  const query = new URLSearchParams();
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.spaceId) query.set("space_id", params.spaceId);
  if (params.limit) query.set("limit", String(params.limit));
  const qs = query.toString();
  return await getJson<SpaceMember[]>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/space/members${qs ? `?${qs}` : ""}`,
  );
}

// ─── Channel Message History (G4) ──────────────────────────────────────────

/** Historical message returned by /v1/bot/messages/sync. */
export interface HistoricalMessage {
  from_uid: string;
  from_name?: string;
  content?: string;
  timestamp: number;
  message_id?: string;
  message_seq?: number;
  /** Numeric MessageType (1=Text, 2=Image, 8=File, 14=RichText, etc.) */
  type?: number;
  url?: string;
  name?: string;
  /** Decoded full payload (server sends base64, we decode + JSON.parse). */
  payload?: Record<string, unknown>;
}

/**
 * Pull recent messages for a channel via the WuKongIM sync endpoint.
 *
 * Used by G4 to backfill conversation history when the local SQLite cache is
 * empty or sparse (e.g. cold start, restored snapshot). The server payload is
 * base64-encoded JSON; we decode it inline so callers get a clean object.
 *
 * Returns `[]` on any failure — the agent runs fine without history.
 */
export async function getChannelMessages(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: number;
  limit?: number;
  startMessageSeq?: number;
  endMessageSeq?: number;
  signal?: AbortSignal;
}): Promise<HistoricalMessage[]> {
  try {
    const result = await postJson<{ messages?: Array<Record<string, unknown>> }>(
      params.apiUrl,
      params.botToken,
      '/v1/bot/messages/sync',
      {
        channel_id: params.channelId,
        channel_type: params.channelType,
        limit: params.limit ?? 20,
        start_message_seq: params.startMessageSeq ?? 0,
        end_message_seq: params.endMessageSeq ?? 0,
        pull_mode: 1, // 1 = pull newer messages
      },
      params.signal,
    );
    const messages = result?.messages ?? [];
    // D1/S7 (齐 P0-2): client-side cap on returned message count. The server
    // could return more than `limit` requested (bug or malice); we map +
    // decode each item which is O(payload size) per message.
    const cap = params.limit ?? 20;
    const limited = messages.length > cap ? messages.slice(0, cap) : messages;
    return limited.map((m) => {
      let payload: Record<string, unknown> | undefined;
      if (typeof m.payload === 'string') {
        // D1/S7 (齐 P0-2): cap base64 payload size before decoding. A 100 MB
        // base64 string would force Buffer.from to allocate ~75 MB synchronously.
        // 256 KiB decoded ≈ 192 KiB binary, well above any legitimate IM payload.
        if (m.payload.length > MAX_HISTORICAL_PAYLOAD_BASE64_LEN) {
          console.warn(
            `octo: getChannelMessages dropping oversized payload (${m.payload.length} base64 chars > ${MAX_HISTORICAL_PAYLOAD_BASE64_LEN})`,
          );
        } else {
          try {
            payload = JSON.parse(Buffer.from(m.payload, 'base64').toString('utf-8'));
          } catch {
            // Leave payload undefined if decoding fails
          }
        }
      } else if (m.payload && typeof m.payload === 'object') {
        payload = m.payload as Record<string, unknown>;
      }
      return {
        from_uid: String(m.from_uid ?? ''),
        from_name: typeof m.from_name === 'string' ? m.from_name : undefined,
        // C1 / P1.5 (Stage 6): WuKongIM /v1/bot/messages/sync ships per-message
        // content / type / url / name INSIDE the base64-encoded payload, not at
        // the top level. Without merging the decoded payload up, every Text
        // history row had `content: undefined`, so seedHistoryFromApi treated
        // every backfilled message as empty and skipped the placeholder branch
        // — G4 backfill was effectively a no-op for Text.
        //
        // Strategy: prefer the top-level field when it is a usable string /
        // number, otherwise fall back to the decoded payload field. We never
        // overwrite a populated top-level value with a payload value, so this
        // is a strict superset of the previous behavior.
        content:
          typeof m.content === 'string' && m.content !== ''
            ? m.content
            : typeof payload?.content === 'string'
              ? payload.content
              : undefined,
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0,
        message_id: typeof m.message_id === 'string' ? m.message_id : undefined,
        message_seq: typeof m.message_seq === 'number' ? m.message_seq : undefined,
        type:
          typeof m.type === 'number'
            ? m.type
            : typeof payload?.type === 'number'
              ? payload.type
              : undefined,
        url:
          typeof m.url === 'string'
            ? m.url
            : typeof payload?.url === 'string'
              ? payload.url
              : undefined,
        name:
          typeof m.name === 'string'
            ? m.name
            : typeof payload?.name === 'string'
              ? payload.name
              : undefined,
        payload,
      };
    });
  } catch (err) {
    console.error(`octo: getChannelMessages error: ${String(err)}`);
    return [];
  }
}
