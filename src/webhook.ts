/**
 * v1.0: Webhook inbound transport.
 *
 * An alternative to the WuKongIM WebSocket: instead of holding a long
 * connection, the gateway runs a small HTTP server that receives Octo message
 * webhooks (POST <path>) and feeds each one into the SAME pipeline the WS path
 * uses (the MessageHandler). The bot still registers over REST for its botId and
 * for outbound sends — webhook mode only changes how INBOUND messages arrive.
 *
 * Security:
 *  - A shared secret is REQUIRED (config validation enforces it). Every request
 *    must present it via `x-webhook-secret` header or `?secret=` query, compared
 *    in constant time. Missing/wrong → 401, no body parsed.
 *  - Request bodies are capped (MAX_WEBHOOK_BODY_BYTES) to avoid memory abuse;
 *    the socket is destroyed once the cap is exceeded.
 *  - Bind host defaults to 127.0.0.1 so the endpoint sits behind a reverse proxy
 *    rather than facing the internet directly.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseOctoJson } from './octo/api.js';
import type { BotMessage } from './octo/types.js';

/** Max inbound body we will buffer before rejecting (256 KiB). */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export interface WebhookOptions {
  host?: string;
  port?: number;
  path?: string;
  secret: string;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_PATH = '/octo/webhook';

/**
 * Constant-time secret compare. Both sides are SHA-256'd to a fixed 32-byte
 * digest first, so neither the comparison time NOR an early length check leaks
 * the expected secret's length.
 */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Parse a raw webhook JSON body into a BotMessage. Returns null when the shape
 * is not a usable message (missing the required fields), so the caller can 400
 * rather than feed garbage into the pipeline.
 */
export function parseWebhookBody(raw: string): BotMessage | null {
  let obj: unknown;
  try {
    // Use the same int64-safe parse as the REST client: a numeric message_id
    // beyond Number.MAX_SAFE_INTEGER (Octo ids are int64) would lose precision
    // under plain JSON.parse. parseOctoJson stringifies 16+ digit ids first.
    obj = parseOctoJson<unknown>(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  // Octo may wrap the message under `message`/`data`, or send it at top level.
  const rec = obj as Record<string, unknown>;
  const candidate = (rec.message ?? rec.data ?? rec) as Record<string, unknown>;
  // Normalize message_id to string: parseOctoJson already stringified large
  // ids; coerce any remaining small numeric id so the BotMessage type holds.
  if (typeof candidate.message_id === 'number') {
    candidate.message_id = String(candidate.message_id);
  }
  // Validate the fields the downstream pipeline relies on. message_seq and
  // timestamp are required numbers (history segmentation + ordering use them);
  // payload must be an object with a numeric `type`; channel_id/channel_type are
  // required so replies and read receipts have somewhere to go.
  const payload = candidate.payload as Record<string, unknown> | undefined | null;
  if (
    typeof candidate.message_id !== 'string' ||
    typeof candidate.from_uid !== 'string' ||
    typeof candidate.message_seq !== 'number' ||
    typeof candidate.timestamp !== 'number' ||
    typeof candidate.channel_id !== 'string' || candidate.channel_id.length === 0 ||
    typeof candidate.channel_type !== 'number' ||
    !payload || typeof payload !== 'object' ||
    typeof payload.type !== 'number'
  ) {
    return null;
  }
  return candidate as unknown as BotMessage;
}

/**
 * HTTP server that turns inbound webhook POSTs into BotMessage handler calls.
 * Mirrors OctoGateway's transport surface enough for index.ts to use it
 * interchangeably: setMessageHandler / listen / close.
 */
export class WebhookServer {
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private readonly secret: string;
  private server: Server | null = null;
  private onMessage: ((msg: BotMessage) => void) | null = null;

  constructor(opts: WebhookOptions) {
    this.host = opts.host ?? DEFAULT_HOST;
    this.port = opts.port ?? DEFAULT_PORT;
    this.path = opts.path ?? DEFAULT_PATH;
    this.secret = opts.secret;
  }

  setMessageHandler(handler: (msg: BotMessage) => void): void {
    this.onMessage = handler;
  }

  /** Start listening. Resolves once the server is bound (or rejects on error). */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.on('error', reject);
      server.listen(this.port, this.host, () => {
        server.off('error', reject);
        console.log(
          `[cc-channel-octo] Webhook listening on http://${this.host}:${this.port}${this.path}`,
        );
        resolve();
      });
      this.server = server;
    });
  }

  /** Stop listening. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // Only POST <path>.
    const url = new URL(req.url ?? '/', `http://${this.host}`);
    if (req.method !== 'POST' || url.pathname !== this.path) {
      res.writeHead(404).end();
      return;
    }
    // Auth: header or query secret, constant-time.
    const provided =
      (req.headers['x-webhook-secret'] as string | undefined) ??
      url.searchParams.get('secret') ?? undefined;
    if (!secretMatches(provided, this.secret)) {
      res.writeHead(401).end();
      return;
    }

    // Buffer raw chunks and decode once at the end — decoding per chunk would
    // corrupt a multibyte (e.g. CJK) codepoint split across a chunk boundary.
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        tooLarge = true;
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const body = Buffer.concat(chunks).toString('utf-8');
      const msg = parseWebhookBody(body);
      if (!msg) {
        res.writeHead(400).end();
        return;
      }
      // ACK promptly; processing is fire-and-forget through the same handler.
      res.writeHead(200).end();
      try {
        this.onMessage?.(msg);
      } catch (err) {
        console.error(`[cc-channel-octo] webhook handler threw: ${String(err)}`);
      }
    });
    req.on('error', () => {
      if (!res.headersSent) res.writeHead(400).end();
    });
  }
}
