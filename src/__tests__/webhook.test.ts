/**
 * webhook transport tests (v1.0): body parsing, auth, size cap, and a real
 * HTTP round-trip into the message handler.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseWebhookBody, WebhookServer, MAX_WEBHOOK_BODY_BYTES } from '../webhook.js';
import type { BotMessage } from '../octo/types.js';
import { MessageType } from '../octo/types.js';

function validMsg(): Record<string, unknown> {
  return {
    message_id: 'm1',
    message_seq: 1,
    from_uid: 'user-1',
    timestamp: 123,
    payload: { type: MessageType.Text, content: 'hi' },
  };
}

describe('parseWebhookBody', () => {
  it('parses a top-level message object', () => {
    const msg = parseWebhookBody(JSON.stringify(validMsg()));
    expect(msg?.message_id).toBe('m1');
    expect(msg?.from_uid).toBe('user-1');
  });

  it('unwraps a { message: ... } envelope', () => {
    const msg = parseWebhookBody(JSON.stringify({ message: validMsg() }));
    expect(msg?.message_id).toBe('m1');
  });

  it('unwraps a { data: ... } envelope', () => {
    const msg = parseWebhookBody(JSON.stringify({ data: validMsg() }));
    expect(msg?.message_id).toBe('m1');
  });

  it('returns null on invalid JSON', () => {
    expect(parseWebhookBody('{not json')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseWebhookBody(JSON.stringify({ message_id: 'x' }))).toBeNull();
    expect(parseWebhookBody(JSON.stringify({ from_uid: 'u', payload: {} }))).toBeNull();
    expect(parseWebhookBody(JSON.stringify({ message_id: 'x', from_uid: 'u' }))).toBeNull();
  });
});

describe('WebhookServer (real HTTP round-trip)', () => {
  let server: WebhookServer | undefined;
  let base: string;
  const SECRET = 'top-secret';
  const PATH = '/octo/webhook';
  let nextPort = 18789;

  async function start(handler?: (m: BotMessage) => void): Promise<void> {
    server = new WebhookServer({ host: '127.0.0.1', port: nextPort++, path: PATH, secret: SECRET });
    if (handler) server.setMessageHandler(handler);
    await server.listen();
    base = `http://127.0.0.1:${nextPort - 1}`;
  }

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it('accepts an authenticated POST and invokes the handler', async () => {
    const received: BotMessage[] = [];
    await start((m) => received.push(m));

    const res = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'x-webhook-secret': SECRET, 'content-type': 'application/json' },
      body: JSON.stringify(validMsg()),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(received).toHaveLength(1);
    expect(received[0].message_id).toBe('m1');
  });

  it('rejects a missing/wrong secret with 401', async () => {
    const handler = vi.fn();
    await start(handler);

    const noSecret = await fetch(`${base}${PATH}`, { method: 'POST', body: JSON.stringify(validMsg()) });
    expect(noSecret.status).toBe(401);
    const wrong = await fetch(`${base}${PATH}`, {
      method: 'POST', headers: { 'x-webhook-secret': 'nope' }, body: JSON.stringify(validMsg()),
    });
    expect(wrong.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts the secret via ?secret= query', async () => {
    await start(vi.fn());
    const res = await fetch(`${base}${PATH}?secret=${SECRET}`, { method: 'POST', body: JSON.stringify(validMsg()) });
    expect(res.status).toBe(200);
  });

  it('404s a wrong path or method', async () => {
    await start();
    const wrongPath = await fetch(`${base}/nope`, {
      method: 'POST', headers: { 'x-webhook-secret': SECRET }, body: '{}',
    });
    expect(wrongPath.status).toBe(404);
    const wrongMethod = await fetch(`${base}${PATH}?secret=${SECRET}`, { method: 'GET' });
    expect(wrongMethod.status).toBe(404);
  });

  it('400s an authenticated but malformed body', async () => {
    const handler = vi.fn();
    await start(handler);
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST', headers: { 'x-webhook-secret': SECRET }, body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an oversized body with 413', async () => {
    const handler = vi.fn();
    await start(handler);
    const huge = 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1024);
    const res = await fetch(`${base}${PATH}`, {
      method: 'POST', headers: { 'x-webhook-secret': SECRET },
      body: JSON.stringify({ ...validMsg(), payload: { type: MessageType.Text, content: huge } }),
    }).catch(() => ({ status: 413 } as Response)); // connection may be destroyed
    expect(res.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });
});
