// Forked from openclaw-channel-octo v1.0.13 (2026-06-04)
// Source: https://github.com/Mininglamp-OSS/openclaw-channel-octo
// Removed: COS upload, GROUP.md API, OBO, rich text, media, thread/group management,
//          read receipts, bot groups list, group info, mention prefs, space members.

import {
  ChannelType,
  MessageType,
  type MentionEntity,
  type SendMessageResult,
} from "./types.js";
import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000;

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
