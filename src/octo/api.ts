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
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${params.groupNo}/members`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.botToken}`,
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`getGroupMembers failed: ${resp.status}`);
  }
  const data = await resp.json() as Record<string, unknown>;
  const members = Array.isArray(data?.members)
    ? data.members
    : Array.isArray(data)
      ? data
      : [];
  return members as GroupMember[];
}

// ─── Channel Message History ────────────────────────────────────────────────

interface SyncMessagePayload {
  type?: number;
  content?: string;
  url?: string;
  name?: string;
  mention?: {
    all?: boolean;
    uids?: string[];
  };
}

export async function getChannelMessages(params: {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  limit?: number;
  startMessageSeq?: number;
  endMessageSeq?: number;
  signal?: AbortSignal;
}): Promise<Array<{
  from_uid: string;
  content: string;
  timestamp: number;
  message_id?: string;
  message_seq?: number;
  type?: number;
  url?: string;
  name?: string;
  payload?: SyncMessagePayload;
}>> {
  try {
    const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/messages/sync`;
    const limit = params.limit ?? 20;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.botToken}`,
      },
      body: JSON.stringify({
        channel_id: params.channelId,
        channel_type: params.channelType,
        limit,
        start_message_seq: params.startMessageSeq ?? 0,
        end_message_seq: params.endMessageSeq ?? 0,
        pull_mode: 1,
      }),
      signal: params.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(`octo: getChannelMessages failed: ${response.status}`);
      return [];
    }

    const text = await response.text();
    const data = text
      ? parseOctoJson<{ messages?: unknown[] }>(text)
      : {};
    const messages = data.messages ?? [];
    return messages.map((m: unknown) => {
      const msg = m as Record<string, unknown>;
      let payload: SyncMessagePayload = {};
      if (msg.payload) {
        try {
          const decoded = Buffer.from(msg.payload as string, "base64").toString("utf-8");
          payload = JSON.parse(decoded) as SyncMessagePayload;
        } catch {
          payload = typeof msg.payload === "object" ? (msg.payload as SyncMessagePayload) : {};
        }
      }
      return {
        from_uid: (msg.from_uid as string) ?? "unknown",
        message_id: (msg.message_id as string) ?? undefined,
        message_seq: (msg.message_seq as number) ?? undefined,
        type: payload.type ?? undefined,
        url: payload.url ?? undefined,
        name: payload.name ?? undefined,
        content: payload.content ?? "",
        payload,
        timestamp: ((msg.timestamp as number) ?? Math.floor(Date.now() / 1000)) * 1000,
      };
    });
  } catch (err) {
    console.error(`octo: getChannelMessages error: ${err}`);
    return [];
  }
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
