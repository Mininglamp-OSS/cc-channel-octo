/**
 * WKSocket packet-level integration tests.
 *
 * Tests the full WKSocket connection and message flow by mocking the `ws`
 * module and feeding binary WuKongIM protocol packets directly through the
 * message handler.
 *
 * Coverage (Q29):
 *  - CONNACK success (reasonCode=1) → onConnected fires
 *  - CONNACK kicked (reasonCode=0) → onError("Kicked by server")
 *  - CONNACK unknown failure (reasonCode=99) → onError with reasonCode
 *  - RECV after CONNACK → onMessage fires with decrypted BotMessage
 *  - PONG packet → no crash, onMessage not called
 *  - DISCONNECT after CONNACK → onError + onDisconnected
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPair, sharedKey } from 'curve25519-js';
import CryptoJS from 'crypto-js';
import { Md5 } from 'md5-typescript';
import { Buffer } from 'buffer';
import { randomBytes } from 'node:crypto';
import { Encoder, Decoder } from '../../octo/socket.js';

// ─── Protocol Constants ──────────────────────────────────────────────────────

const PacketType = {
  CONNECT: 1,
  CONNACK: 2,
  RECV: 5,
  PING: 7,
  PONG: 8,
  DISCONNECT: 9,
} as const;

const TEST_SALT = 'salt1234567890abcdef'; // > 16 chars → aesIV = first 16

// ─── Shared WebSocket mock state ─────────────────────────────────────────────

interface IMockWS {
  sent: Uint8Array[];
  on(event: string, handler: (...args: unknown[]) => void): void;
  send(data: Uint8Array): void;
  close(): void;
  removeAllListeners(): void;
  emit(event: string, ...args: unknown[]): void;
}

const wsRef = vi.hoisted(() => ({ current: null as IMockWS | null }));

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

    close(): void {}
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

// ─── Binary Protocol Helpers ─────────────────────────────────────────────────

function encodeVariableLength(len: number): number[] {
  if (len === 0) return [0];
  const ret: number[] = [];
  while (len > 0) {
    let digit = len % 0x80;
    len = Math.floor(len / 0x80);
    if (len > 0) digit |= 0x80;
    ret.push(digit);
  }
  return ret;
}

function buildConnackPacket(opts: {
  hasServerVersion: boolean;
  serverVersion?: number;
  timeDiff?: bigint;
  reasonCode: number;
  serverKey: string;
  salt: string;
  nodeId?: bigint;
}): Uint8Array {
  const sv = opts.serverVersion ?? 4;
  const body = new Encoder();
  if (opts.hasServerVersion) {
    body.writeByte(sv);
  }
  body.writeInt64(opts.timeDiff ?? 0n);
  body.writeByte(opts.reasonCode);
  body.writeString(opts.serverKey);
  body.writeString(opts.salt);
  if (opts.hasServerVersion && sv >= 4) {
    body.writeInt64(opts.nodeId ?? 1n);
  }
  const bodyBytes = Array.from(body.toUint8Array());

  const frame = new Encoder();
  const flags = opts.hasServerVersion ? 1 : 0;
  frame.writeByte((PacketType.CONNACK << 4) | flags);
  frame.writeBytes(encodeVariableLength(bodyBytes.length));
  frame.writeBytes(bodyBytes);
  return frame.toUint8Array();
}

function buildRecvPacket(opts: {
  serverVersion: number;
  fromUID: string;
  channelID: string;
  channelType: number;
  messageID: bigint;
  messageSeq: number;
  timestamp: number;
  payload: Record<string, unknown>;
  aesKey: string;
  aesIV: string;
}): Uint8Array {
  // Encrypt payload — wire format is ASCII bytes of the base64 ciphertext string
  const payloadStr = JSON.stringify(opts.payload);
  const encryptedBase64 = CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(payloadStr),
    CryptoJS.enc.Utf8.parse(opts.aesKey),
    {
      keySize: 128 / 8,
      iv: CryptoJS.enc.Utf8.parse(opts.aesIV),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  ).toString(); // base64 string
  const encryptedBytes = Array.from(new TextEncoder().encode(encryptedBase64));

  const body = new Encoder();
  body.writeByte(0); // settingByte: no topic, no receipt, no stream
  body.writeString('msgkey_test');
  body.writeString(opts.fromUID);
  body.writeString(opts.channelID);
  body.writeByte(opts.channelType);
  if (opts.serverVersion >= 3) {
    body.writeInt32(0); // expire
  }
  body.writeString('client_msg_001');
  body.writeInt64(opts.messageID);
  body.writeInt32(opts.messageSeq);
  body.writeInt32(opts.timestamp);
  // No topic (settingByte bit 3 = 0)
  body.writeBytes(encryptedBytes);
  const bodyBytes = Array.from(body.toUint8Array());

  const frame = new Encoder();
  frame.writeByte((PacketType.RECV << 4) | 0);
  frame.writeBytes(encodeVariableLength(bodyBytes.length));
  frame.writeBytes(bodyBytes);
  return frame.toUint8Array();
}

function buildDisconnectPacket(reasonCode: number, reason: string): Uint8Array {
  const body = new Encoder();
  body.writeByte(reasonCode);
  body.writeString(reason);
  const bodyBytes = Array.from(body.toUint8Array());

  const frame = new Encoder();
  frame.writeByte((PacketType.DISCONNECT << 4) | 0);
  frame.writeBytes(encodeVariableLength(bodyBytes.length));
  frame.writeBytes(bodyBytes);
  return frame.toUint8Array();
}

/** Parse the CONNECT packet sent by WKSocket and extract the client's DH public key. */
function parseConnectPacket(data: Uint8Array): { clientKey: string } {
  const dec = new Decoder(data);
  dec.readByte();            // header byte
  dec.readVariableLength();  // remaining length
  dec.readByte();            // version
  dec.readByte();            // deviceFlag
  dec.readString();          // deviceID
  dec.readString();          // uid
  dec.readString();          // token
  dec.readInt64BigInt();     // clientTimestamp
  const clientKey = dec.readString();
  return { clientKey };
}

// ─── Test Fixtures ───────────────────────────────────────────────────────────

function makeSocket(
  onMessage: ReturnType<typeof vi.fn>,
  onConnected?: ReturnType<typeof vi.fn>,
  onError?: ReturnType<typeof vi.fn>,
  onDisconnected?: ReturnType<typeof vi.fn>,
): WKSocket {
  return new WKSocket({
    wsUrl: 'wss://test.example.com/v1',
    uid: 'bot_uid',
    token: 'bot_token',
    onMessage,
    onConnected,
    onError,
    onDisconnected,
  });
}

/**
 * Execute the CONNACK handshake for a connected socket.
 * Returns the derived AES key/IV and the server key pair.
 */
function doHandshake(
  ws: IMockWS,
  reasonCode: number,
  salt = TEST_SALT,
): { aesKey: string; aesIV: string; serverKP: ReturnType<typeof generateKeyPair> } {
  const { clientKey } = parseConnectPacket(new Uint8Array(ws.sent[0]));
  const clientPubKey = new Uint8Array(Buffer.from(clientKey, 'base64'));

  const serverSeed = randomBytes(32);
  const serverKP = generateKeyPair(serverSeed);
  const serverKeyBase64 = Buffer.from(serverKP.public).toString('base64');

  // Derive AES key (mirrors onConnack logic)
  const secret = sharedKey(serverKP.private, clientPubKey);
  const secretBase64 = Buffer.from(secret).toString('base64');
  const aesKey = Md5.init(secretBase64).substring(0, 16);
  const aesIV = salt.length > 16 ? salt.substring(0, 16) : salt;

  const connack = buildConnackPacket({
    hasServerVersion: true,
    serverVersion: 4,
    reasonCode,
    serverKey: serverKeyBase64,
    salt,
  });
  ws.emit('message', Buffer.from(connack));

  return { aesKey, aesIV, serverKP };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WKSocket packet-level integration', () => {
  let socket: WKSocket | null = null;

  beforeEach(() => {
    wsRef.current = null;
  });

  afterEach(() => {
    socket?.disconnect();
    socket = null;
  });

  // ── Test 1: CONNACK success ─────────────────────────────────────────────

  it('CONNACK reasonCode=1 → onConnected fires', () => {
    const onConnected = vi.fn();
    const onError = vi.fn();

    socket = makeSocket(vi.fn(), onConnected, onError);
    socket.connect();
    const ws = wsRef.current!;
    ws.emit('open');

    doHandshake(ws, 1);

    expect(onConnected).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  // ── Test 2: CONNACK kicked (reasonCode=0) ───────────────────────────────

  it('CONNACK reasonCode=0 → onError fires with "Kicked"', () => {
    const onConnected = vi.fn();
    const onError = vi.fn();

    socket = makeSocket(vi.fn(), onConnected, onError);
    socket.connect();
    const ws = wsRef.current!;
    ws.emit('open');

    doHandshake(ws, 0);

    expect(onConnected).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toContain('Kicked');
  });

  // ── Test 3: CONNACK unknown failure ─────────────────────────────────────

  it('CONNACK reasonCode=99 → onError fires with reasonCode', () => {
    const onConnected = vi.fn();
    const onError = vi.fn();

    socket = makeSocket(vi.fn(), onConnected, onError);
    socket.connect();
    const ws = wsRef.current!;
    ws.emit('open');

    doHandshake(ws, 99);

    expect(onConnected).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    const err = onError.mock.calls[0][0] as Error;
    expect(err.message).toContain('reasonCode=99');
  });

  // ── Test 4: RECV after CONNACK → onMessage with decrypted payload ───────

  it('RECV after CONNACK → onMessage fires with decrypted BotMessage', () => {
    const onMessage = vi.fn();
    const onConnected = vi.fn();

    socket = makeSocket(onMessage, onConnected);
    socket.connect();
    const ws = wsRef.current!;
    ws.emit('open');

    const { aesKey, aesIV } = doHandshake(ws, 1);
    expect(onConnected).toHaveBeenCalledOnce();

    const payload = { type: 1, content: 'hello from test' };
    const recv = buildRecvPacket({
      serverVersion: 4,
      fromUID: 'sender_uid',
      channelID: 'group_ch',
      channelType: 2,
      messageID: 1234567890n,
      messageSeq: 42,
      timestamp: 1717000000,
      payload,
      aesKey,
      aesIV,
    });
    ws.emit('message', Buffer.from(recv));

    expect(onMessage).toHaveBeenCalledOnce();
    const msg = onMessage.mock.calls[0][0];
    expect(msg.from_uid).toBe('sender_uid');
    expect(msg.channel_id).toBe('group_ch');
    expect(msg.channel_type).toBe(2);
    expect(msg.payload.type).toBe(1);
    expect(msg.payload.content).toBe('hello from test');
  });

  // ── Test 5: PONG resets ping counter without error ──────────────────────

  it('PONG packet after CONNACK → no crash, onMessage not called', () => {
    const onMessage = vi.fn();
    const onConnected = vi.fn();

    socket = makeSocket(onMessage, onConnected);
    socket.connect();
    const ws = wsRef.current!;
    ws.emit('open');

    doHandshake(ws, 1);
    expect(onConnected).toHaveBeenCalledOnce();

    // PONG is a single byte: PacketType.PONG << 4 = 8 << 4 = 0x80
    expect(() => {
      ws.emit('message', Buffer.from([0x80]));
    }).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
  });

  // ── Test 6: DISCONNECT after CONNACK → onError + onDisconnected ─────────

  it('DISCONNECT after CONNACK → onError("Kicked") and onDisconnected', () => {
    const onMessage = vi.fn();
    const onConnected = vi.fn();
    const onError = vi.fn();
    const onDisconnected = vi.fn();

    socket = makeSocket(onMessage, onConnected, onError, onDisconnected);
    socket.connect();
    const ws = wsRef.current!;
    ws.emit('open');

    doHandshake(ws, 1);
    expect(onConnected).toHaveBeenCalledOnce();

    const disconnect = buildDisconnectPacket(1, 'server initiated disconnect');
    ws.emit('message', Buffer.from(disconnect));

    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0][0] as Error).message).toContain('Kicked');
    expect(onDisconnected).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
