// Forked from openclaw-channel-octo v1.0.13 (2026-06-04)
// Source: https://github.com/Mininglamp-OSS/openclaw-channel-octo
// Removed: COS upload, OBO, rich text, media, group management,
//          read receipts, bot groups list, group info, mention prefs, space members.
// Restored: thread lifecycle (create/list/get/delete/members/join/leave) — see
//          "Thread Lifecycle" section below; GROUP.md server API (get/update) —
//          see "Group Markdown (GROUP.md)" section below.

import {
  ChannelType,
  MessageType,
  type MentionEntity,
  type SendMessageResult,
  type Thread,
  type ThreadMember,
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
 *
 * Exported so other inbound paths parse Octo JSON with the same int64 safety as
 * the REST client.
 */
export function parseOctoJson<T>(text: string): T {
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
 * Get STS temporary credentials for direct COS upload.
 * GET /v1/bot/upload/credentials?filename=<encoded>
 *
 * Returns short-lived (typically 1h) credentials scoped to a single key.
 * cc only uses this to probe the media CDN host (see index.ts); actual uploads
 * are performed by the agent's octo-cli skill, not by cc itself.
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
  // Only send message-level ids that are actually present. An empty / blank id
  // makes the server resolve a message_seq it cannot find, which the IM backend
  // rejects — so omit message_ids entirely when there is nothing valid to ack
  // (the request then just clears the conversation unread badge).
  const ids = (params.messageIds ?? []).filter((id) => id && id.trim() !== '');
  await postJson(params.apiUrl, params.botToken, '/v1/bot/readReceipt', {
    channel_id: params.channelId,
    channel_type: params.channelType,
    ...(ids.length > 0 ? { message_ids: ids } : {}),
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

// ─── Thread Lifecycle ────────────────────────────────────────────────────────
//
// Restores the bot thread (CommunityTopic) lifecycle endpoints that were removed
// at fork time (see file header). Path / method / auth are a verbatim restore of
// openclaw-channel-octo api-fetch.ts (createThread … leaveThread); each call is
// routed through this client's postJson/getJson/requestNoBody helpers so it
// shares the same timeout, Bearer auth, int64-safe JSON parse, and error-message
// format as the rest of the API surface.

/**
 * Issue a request that carries neither a request body nor a meaningful response
 * body (thread delete / join / leave). Mirrors postJson's timeout, Bearer auth,
 * and error-message format. A 2xx with an empty body resolves to void.
 */
async function requestNoBody(
  apiUrl: string,
  botToken: string,
  method: "POST" | "DELETE",
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const resp = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${botToken}` },
    signal: effectiveSignal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
}

/**
 * Serialize an int64 id (e.g. a snowflake message id) into a request body as a
 * *bare JSON number* with full precision preserved.
 *
 * The Octo backend requires `source_message_id` to be a JSON number — a quoted
 * string is rejected with 400 request_invalid. But a 19-digit snowflake exceeds
 * Number.MAX_SAFE_INTEGER (2^53-1), so the value must never pass through a JS
 * `number`, which would silently truncate it. We therefore keep it as a string
 * end-to-end and hand it to JSON.stringify verbatim via JSON.rawJSON (Node >=21),
 * yielding wire JSON such as `"source_message_id":2071497871135346688`.
 *
 * JSON.rawJSON is not in the ES2022 lib typings yet, so it is accessed through a
 * narrow cast rather than `any`.
 */
function rawInt64(value: string): unknown {
  if (!/^-?[0-9]+$/.test(value)) {
    throw new Error(`int64 id must be a base-10 integer string, got: ${value}`);
  }
  return (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(value);
}

/** Create a thread under a parent group. POST /v1/bot/groups/{groupNo}/threads */
export async function createThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  name: string;
  /** Optional: anchor the thread to the message it was started from. Accepted as
   *  a string to stay int64-safe, but emitted on the wire as a bare JSON number
   *  (the server rejects a quoted value); see rawInt64. */
  sourceMessageId?: string;
  signal?: AbortSignal;
}): Promise<Thread | undefined> {
  const body: Record<string, unknown> = { name: params.name };
  if (params.sourceMessageId != null) body.source_message_id = rawInt64(params.sourceMessageId);
  return await postJson<Thread>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads`,
    body,
    params.signal,
  );
}

/** List threads under a parent group. GET /v1/bot/groups/{groupNo}/threads */
export async function listThreads(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  signal?: AbortSignal;
}): Promise<Thread[]> {
  const data = await getJson<Record<string, unknown>>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads`,
    params.signal,
  );
  // Tolerate both a bare array and a `{ threads: [...] }` envelope, mirroring
  // getGroupMembers' defensive shape handling.
  const threads = Array.isArray(data?.threads)
    ? data.threads
    : Array.isArray(data)
      ? data
      : [];
  return threads as Thread[];
}

/** Get a single thread. GET /v1/bot/groups/{groupNo}/threads/{shortId} */
export async function getThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<Thread> {
  return await getJson<Thread>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}`,
    params.signal,
  );
}

/** Delete a thread. DELETE /v1/bot/groups/{groupNo}/threads/{shortId} */
export async function deleteThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await requestNoBody(
    params.apiUrl,
    params.botToken,
    "DELETE",
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}`,
    params.signal,
  );
}

/** List a thread's members. GET /v1/bot/groups/{groupNo}/threads/{shortId}/members */
export async function listThreadMembers(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<ThreadMember[]> {
  const data = await getJson<Record<string, unknown>>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/members`,
    params.signal,
  );
  const members = Array.isArray(data?.members)
    ? data.members
    : Array.isArray(data)
      ? data
      : [];
  return members as ThreadMember[];
}

/** Join a thread. POST /v1/bot/groups/{groupNo}/threads/{shortId}/join */
export async function joinThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await requestNoBody(
    params.apiUrl,
    params.botToken,
    "POST",
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/join`,
    params.signal,
  );
}

/** Leave a thread. POST /v1/bot/groups/{groupNo}/threads/{shortId}/leave */
export async function leaveThread(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<void> {
  await requestNoBody(
    params.apiUrl,
    params.botToken,
    "POST",
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/leave`,
    params.signal,
  );
}

// ─── Group Markdown (GROUP.md) ───────────────────────────────────────────────
//
// Restores the GROUP.md server API removed at fork time (see file header). A
// group's GROUP.md is operator-authored persona / rules stored server-side; the
// gateway fetches it (server-first) and injects it as a trusted instruction
// block into the agent's system prompt. Path / method / auth / response shape
// are a verbatim restore of openclaw-channel-octo api-fetch.ts
// (getGroupMd / updateGroupMd), routed through this client's getJson helper so
// GET shares the same timeout, Bearer auth, int64-safe JSON parse and
// error-message format as the rest of the API surface.

/** Server GROUP.md payload returned by GET /v1/bot/groups/{groupNo}/md. */
export interface GroupMd {
  content: string;
  version: number;
  updated_at: string | null;
  updated_by: string;
}

/**
 * Fetch a group's server-side GROUP.md. GET /v1/bot/groups/{groupNo}/md.
 *
 * Throws on any non-2xx (including 404 "no GROUP.md set") — the caller decides
 * how to degrade. The server-first fetch orchestrator (group-md.ts) catches and
 * falls back to the local instruction file, so a 404 cleanly downgrades to local.
 */
export async function getGroupMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  signal?: AbortSignal;
}): Promise<GroupMd> {
  return await getJson<GroupMd>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/md`,
    params.signal,
  );
}

/**
 * Server THREAD.md payload returned by GET /v1/bot/groups/{groupNo}/threads/{shortId}/md.
 *
 * Same shape as {@link GroupMd} — the thread markdown endpoint is symmetric to
 * the group one (verified against the live backend: 200 with
 * `{content, version, updated_at, updated_by}`). A thread carries its OWN
 * operator-authored instructions; it does NOT inherit the parent group's GROUP.md.
 */
export interface ThreadMd {
  content: string;
  version: number;
  updated_at: string | null;
  updated_by: string;
}

/**
 * Fetch a thread's server-side THREAD.md.
 * GET /v1/bot/groups/{groupNo}/threads/{shortId}/md.
 *
 * The endpoint is symmetric to {@link getGroupMd} (group md = `.../groups/{groupNo}/md`;
 * thread md = `.../groups/{groupNo}/threads/{shortId}/md`), sharing the same
 * getJson timeout / Bearer auth / int64-safe JSON parse / error-message format.
 *
 * Throws on any non-2xx (including 404 "no THREAD.md set") — the caller
 * (group-md.ts thread branch) catches and falls back to the local
 * `<shortId>.md` file, mirroring the group server-first degrade path.
 */
export async function getThreadMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
}): Promise<ThreadMd> {
  return await getJson<ThreadMd>(
    params.apiUrl,
    params.botToken,
    `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/md`,
    params.signal,
  );
}

/**
 * Update a group's server-side GROUP.md (requires bot_admin permission).
 * PUT /v1/bot/groups/{groupNo}/md, body `{ content }` → `{ version }`.
 *
 * NOTE (P2-A scope): this client function is restored alongside getGroupMd, but
 * is intentionally NOT wired into any write-back path here — the PUT trigger
 * chain is owned by a separate work item. Mirrors postJson's timeout, Bearer
 * auth and error-message format.
 */
export async function updateGroupMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  content: string;
  signal?: AbortSignal;
}): Promise<{ version: number }> {
  const path = `/v1/bot/groups/${encodeURIComponent(params.groupNo)}/md`;
  const url = `${params.apiUrl.replace(/\/+$/, "")}${path}`;
  const effectiveSignal = params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${params.botToken}`,
    },
    body: JSON.stringify({ content: params.content }),
    signal: effectiveSignal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Octo API ${path} failed (${resp.status}): ${text || resp.statusText}`);
  }
  const text = await resp.text();
  if (!text) return { version: 0 };
  return parseOctoJson<{ version: number }>(text);
}
