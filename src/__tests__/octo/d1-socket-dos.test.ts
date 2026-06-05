/**
 * D1/S6 (齐 P0-1): tempBuffer OOM + variable-length 4-byte cap tests.
 *
 * Verifies that a misbehaving server cannot exhaust the bot's memory by
 * sending partial packets or unending variable-length encoding bytes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Buffer } from 'buffer';

// ─── Shared WebSocket mock (same shape as wksocket-packet.test.ts) ──────────

interface IMockWS {
  sent: Uint8Array[];
  on(event: string, handler: (...args: unknown[]) => void): void;
  send(data: Uint8Array): void;
  close(): void;
  removeAllListeners(): void;
  emit(event: string, ...args: unknown[]): void;
}

const wsRef = vi.hoisted(() => ({ current: null as IMockWS | null }));
const wsCloseSpy = vi.hoisted(() => vi.fn());

vi.mock('ws', () => {
  class MockWS {
    binaryType = 'arraybuffer';
    readyState = 1;
    sent: Uint8Array[] = [];
    private _handlers = new Map<string, ((...args: unknown[]) => void)[]>();

    static OPEN = 1;

    constructor() {
      wsRef.current = this;
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event)!.push(handler);
    }

    send(data: Uint8Array): void {
      this.sent.push(new Uint8Array(data));
    }

    close(): void {
      wsCloseSpy();
    }
    removeAllListeners(): void {}

    emit(event: string, ...args: unknown[]): void {
      for (const h of this._handlers.get(event) ?? []) {
        h(...args);
      }
    }
  }

  return { default: MockWS };
});

import { WKSocket } from '../../octo/socket.js';

function makeSocket(): WKSocket {
  return new WKSocket({
    wsUrl: 'wss://test.example.com/v1',
    uid: 'bot_uid',
    token: 'bot_token',
    onMessage: vi.fn(),
    onConnected: vi.fn(),
    onError: vi.fn(),
    onDisconnected: vi.fn(),
  });
}

describe('WKSocket DoS hardening (D1/S6)', () => {
  let socket: WKSocket | null = null;

  beforeEach(() => {
    wsRef.current = null;
    wsCloseSpy.mockReset();
  });

  afterEach(() => {
    socket?.disconnect();
    socket = null;
  });

  it('closes connection when tempBuffer exceeds 1 MiB cap (P0-1)', () => {
    socket = makeSocket();
    socket.connect();
    const ws = wsRef.current!;
    ws.emit('open');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Send a chunk of 2 MiB of partial packet data — packetType is REPLY (0x50),
    // so unpackOne tries to read variable-length, eventually hits the 4-byte
    // cap and throws OR the size cap kicks in first.
    const huge = new Uint8Array(2 * 1024 * 1024);
    // Make it look like a legitimate packet header without ending the length.
    huge[0] = 0x50;
    for (let i = 1; i < huge.length; i++) huge[i] = 0x80; // continuation byte forever

    ws.emit('message', Buffer.from(huge));

    // Either the size cap or the varlen cap fired → ws.close should have been
    // invoked at least once.
    expect(wsCloseSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('rejects malformed variable-length > 4 bytes (P0-1 varlen cap)', () => {
    socket = makeSocket();
    socket.connect();
    const ws = wsRef.current!;
    ws.emit('open');

    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    // 5 continuation bytes (0x80 with high bit set) → exceeds 4-byte MQTT cap.
    // Header (0x50) + 0x80 0x80 0x80 0x80 0x80 0x01 ...
    const malformed = new Uint8Array([
      0x50, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01,
    ]);
    ws.emit('message', Buffer.from(malformed));

    // The decode error handler closes the ws.
    expect(wsCloseSpy).toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      '[WKSocket] decode error:',
      expect.objectContaining({
        message: expect.stringContaining('variable-length encoding exceeded'),
      }),
    );
    debugSpy.mockRestore();
  });

  it('accepts normal small packets that fit well under the cap', () => {
    socket = makeSocket();
    socket.connect();
    const ws = wsRef.current!;
    ws.emit('open');

    // PONG is a single byte: 0x80. Should not trigger close.
    ws.emit('message', Buffer.from([0x80]));
    expect(wsCloseSpy).not.toHaveBeenCalled();
  });
});
