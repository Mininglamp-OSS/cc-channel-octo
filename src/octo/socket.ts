// Forked from openclaw-channel-octo v1.0.13 (2026-06-04)
// Source: https://github.com/Mininglamp-OSS/openclaw-channel-octo
// Changes: Exported Encoder and Decoder classes for protocol testing.

import { EventEmitter } from "events";
import WebSocket from "ws";
import { generateKeyPair, sharedKey } from "curve25519-js";
import { Buffer } from "buffer";
import CryptoJS from "crypto-js";
import { Md5 } from "md5-typescript";
import { randomBytes } from "node:crypto";
import type { BotMessage, MessagePayload, MessageType } from "./types.js";

// ─── WuKongIM Binary Protocol Constants ─────────────────────────────────────

const enum PacketType {
  CONNECT = 1,
  CONNACK = 2,
  SEND = 3,
  SENDACK = 4,
  RECV = 5,
  RECVACK = 6,
  PING = 7,
  PONG = 8,
  DISCONNECT = 9,
}

const PROTO_VERSION = 4;

/**
 * Maximum bytes allowed in the WebSocket inbound assembly buffer.
 * D1/S6 (齐 P0-1): a malicious server can send partial packets indefinitely
 * (e.g. an unending variable-length encoding) and OOM the bot. 1 MiB is
 * >> any legitimate single packet — if we cross it, close + reconnect.
 */
const MAX_TEMP_BUFFER_BYTES = 1 * 1024 * 1024;

/**
 * Maximum bytes used to encode a single variable-length integer (MQTT spec).
 * D1/S6: refuse > 4 continuation bytes — anything longer is malformed and
 * keeps tempBuffer filling forever.
 */
const MAX_VARLEN_BYTES = 4;

/**
 * Per-message decrypt/parse failure cap. After this many failed attempts on the
 * SAME messageID, ack-and-drop it so a single poison (corrupt / non-JSON)
 * payload cannot wedge the stream via infinite server redelivery. A transient
 * failure (< cap) is left un-acked so the server retries.
 */
const MAX_DECRYPT_RETRIES = 3;

/** Cap on distinct messageIDs tracked for decrypt failures (memory bound). */
const MAX_DECRYPT_FAIL_ENTRIES = 1000;

// ─── Binary Encoder / Decoder ───────────────────────────────────────────────

export class Encoder {
  private w: number[] = [];
  writeByte(b: number) { this.w.push(b & 0xff); }
  writeBytes(b: number[]) { for (let i = 0; i < b.length; i++) this.w[this.w.length] = b[i]; }
  writeInt16(b: number) { this.w.push((b >> 8) & 0xff, b & 0xff); }
  writeInt32(b: number) { this.w.push((b >> 24) & 0xff, (b >> 16) & 0xff, (b >> 8) & 0xff, b & 0xff); }
  writeInt64(n: bigint) {
    const hi = Number(n >> 32n);
    const lo = Number(n & 0xffffffffn);
    this.writeInt32(hi);
    this.writeInt32(lo);
  }
  writeString(s: string) {
    if (s && s.length > 0) {
      const arr = stringToUint(s);
      this.writeInt16(arr.length);
      for (let i = 0; i < arr.length; i++) this.w[this.w.length] = arr[i];
    } else {
      this.writeInt16(0);
    }
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.w); }
}

export class Decoder {
  private offset = 0;
  constructor(private data: Uint8Array) {}

  readByte(): number { return this.data[this.offset++]; }

  readInt16(): number {
    const v = (this.data[this.offset] << 8) | this.data[this.offset + 1];
    this.offset += 2;
    return v;
  }

  readInt32(): number {
    const v =
      (this.data[this.offset] << 24) |
      (this.data[this.offset + 1] << 16) |
      (this.data[this.offset + 2] << 8) |
      this.data[this.offset + 3];
    this.offset += 4;
    return v >>> 0; // unsigned
  }

  readInt64String(): string {
    // Read 8 bytes as a big-endian unsigned integer string
    let n = BigInt(0);
    for (let i = 0; i < 8; i++) {
      n = (n << 8n) | BigInt(this.data[this.offset + i]);
    }
    this.offset += 8;
    return n.toString();
  }

  readInt64BigInt(): bigint {
    let n = BigInt(0);
    for (let i = 0; i < 8; i++) {
      n = (n << 8n) | BigInt(this.data[this.offset + i]);
    }
    this.offset += 8;
    return n;
  }

  readString(): string {
    const len = this.readInt16();
    if (len <= 0) return "";
    const slice = this.data.slice(this.offset, this.offset + len);
    this.offset += len;
    return uintToString(Array.from(slice));
  }

  readRemaining(): Uint8Array {
    const d = this.data.slice(this.offset);
    this.offset = this.data.length;
    return d;
  }

  readVariableLength(): number {
    let multiplier = 0;
    let rLength = 0;
    while (multiplier < 27) {
      const b = this.readByte();
      rLength = rLength | ((b & 127) << multiplier);
      if ((b & 128) === 0) break;
      multiplier += 7;
    }
    return rLength;
  }
}

function stringToUint(str: string): number[] {
  return Array.from(new TextEncoder().encode(str));
}

function uintToString(array: number[]): string {
  return new TextDecoder().decode(new Uint8Array(array));
}

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

// ─── AES-CBC Encryption Helpers ─────────────────────────────────────────────

function aesDecrypt(data: Uint8Array, aesKey: string, aesIV: string): Uint8Array {
  const str = Buffer.from(data).toString("binary");
  const ciphertext = CryptoJS.enc.Base64.parse(str);
  const decrypted = CryptoJS.AES.decrypt(
    CryptoJS.enc.Base64.stringify(ciphertext),
    CryptoJS.enc.Utf8.parse(aesKey),
    {
      keySize: 128 / 8,
      iv: CryptoJS.enc.Utf8.parse(aesIV),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  );
  return Uint8Array.from(Buffer.from(decrypted.toString(CryptoJS.enc.Utf8)));
}

// ─── Packet Encoding / Decoding ─────────────────────────────────────────────

function encodeConnectPacket(opts: {
  version: number;
  deviceFlag: number;
  deviceID: string;
  uid: string;
  token: string;
  clientTimestamp: number;
  clientKey: string;
}): Uint8Array {
  const body = new Encoder();
  body.writeByte(opts.version);
  body.writeByte(opts.deviceFlag);
  body.writeString(opts.deviceID);
  body.writeString(opts.uid);
  body.writeString(opts.token);
  body.writeInt64(BigInt(opts.clientTimestamp));
  body.writeString(opts.clientKey);
  const bodyBytes = Array.from(body.toUint8Array());

  const frame = new Encoder();
  // header: packetType << 4 | flags
  frame.writeByte((PacketType.CONNECT << 4) | 0);
  frame.writeBytes(encodeVariableLength(bodyBytes.length));
  frame.writeBytes(bodyBytes);
  return frame.toUint8Array();
}

function encodePingPacket(): Uint8Array {
  return new Uint8Array([(PacketType.PING << 4) | 0]);
}

function encodeRecvackPacket(messageID: string, messageSeq: number): Uint8Array {
  const body = new Encoder();
  body.writeInt64(BigInt(messageID));
  body.writeInt32(messageSeq);
  const bodyBytes = Array.from(body.toUint8Array());

  const frame = new Encoder();
  frame.writeByte((PacketType.RECVACK << 4) | 0);
  frame.writeBytes(encodeVariableLength(bodyBytes.length));
  frame.writeBytes(bodyBytes);
  return frame.toUint8Array();
}

interface SettingFlags {
  receiptEnabled: boolean;
  topic: boolean;
  streamOn: boolean;
}

function parseSettingByte(v: number): SettingFlags {
  return {
    receiptEnabled: ((v >> 7) & 0x01) > 0,
    topic: ((v >> 3) & 0x01) > 0,
    streamOn: ((v >> 1) & 0x01) > 0,
  };
}

// ─── WKSocket — Independent WebSocket Connection ────────────────────────────

interface WKSocketOptions {
  wsUrl: string;
  uid: string;
  token: string;
  onMessage: (msg: BotMessage) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
}

/**
 * WuKongIM WebSocket client for bot connections.
 *
 * Implements the WuKongIM binary protocol directly over WebSocket,
 * with per-instance DH key exchange, AES encryption, heartbeat,
 * reconnect, and RECVACK.
 *
 * Each WKSocket instance maintains its own independent connection,
 * enabling multiple bot accounts to run simultaneously.
 */
export class WKSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private connected = false;
  private needReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartTimer: ReturnType<typeof setInterval> | null = null;
  private pingRetryCount = 0;
  private readonly pingMaxRetry = 3;
  private reconnectAttempts = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConnectTime = 0;
  private rapidDisconnectCount = 0;

  // Per-instance crypto state (set after CONNACK)
  private aesKey = "";
  private aesIV = "";
  private dhPrivateKey: Uint8Array | null = null;
  private serverVersion = 0;

  // Buffer for handling packet fragmentation (sticky packets)
  private tempBuffer: number[] = [];

  // Per-message decrypt-failure counts (by messageID). After
  // MAX_DECRYPT_RETRIES, a poison message is ack'd-and-dropped so the server
  // stops redelivering it forever (a single corrupt/non-JSON payload must not
  // wedge the stream). Bounded to avoid unbounded growth from many distinct ids.
  private decryptFailCounts = new Map<string, number>();

  constructor(private opts: WKSocketOptions) {
    super();
  }

  /** Connect to WuKongIM WebSocket */
  connect(): void {
    this.needReconnect = true;
    this.doConnect();
  }

  /** Gracefully disconnect */
  disconnect(): void {
    this.needReconnect = false;
    this.connected = false;
    this.lastConnectTime = 0;
    this.rapidDisconnectCount = 0;
    this.stopHeart();
    this.stopReconnectTimer();
    this.clearStableTimer();
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  /** Disconnect and wait for the old WS to fully close before resolving. */
  async disconnectAndWait(timeoutMs = 2000): Promise<void> {
    this.needReconnect = false;
    this.connected = false;
    this.stopHeart();
    this.stopReconnectTimer();
    this.clearStableTimer();

    const oldWs = this.ws;
    this.ws = null;
    this.lastConnectTime = 0;
    this.rapidDisconnectCount = 0;

    if (!oldWs) return;

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        oldWs.removeAllListeners();
        resolve();
      };
      oldWs.on("close", done);
      try { oldWs.close(); } catch { /* ignore */ }
      setTimeout(() => {
        if (!resolved) {
          try { (oldWs as WebSocket & { terminate?: () => void }).terminate?.(); } catch { /* ignore */ }
          done();
        }
      }, timeoutMs);
    });
  }

  // ─── Internal Connection Logic ──────────────────────────────────────────

  private doConnect(): void {
    this.clearStableTimer();
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }

    this.tempBuffer = [];
    const ws = new WebSocket(this.opts.wsUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return; // stale guard
      this.tempBuffer = [];
      // Generate DH key pair
      const seed = randomBytes(32);
      const keyPair = generateKeyPair(seed);
      this.dhPrivateKey = keyPair.private;
      const pubKey = Buffer.from(keyPair.public).toString("base64");

      const deviceID = generateDeviceID() + "W";
      const packet = encodeConnectPacket({
        version: PROTO_VERSION,
        deviceFlag: 0, // 0 = app/bot
        deviceID,
        uid: this.opts.uid,
        token: this.opts.token,
        clientTimestamp: Date.now(),
        clientKey: pubKey,
      });
      ws.send(packet);
    });

    ws.on("message", (data: ArrayBuffer | Buffer) => {
      if (this.ws !== ws) return; // stale guard
      // Buffer is already a Uint8Array view; use it directly to avoid the
      // 3-arg vs 1-arg footgun. `new Uint8Array(buffer)` without byteOffset/
      // byteLength reads the WHOLE underlying ArrayBuffer, which for a Buffer
      // that is a view (e.g. from a buffer pool) leaks adjacent memory into
      // the frame parser.
      const bytes: Uint8Array = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      this.handleRawData(bytes);
    });

    ws.on("close", () => {
      // Ignore close events from stale WebSocket instances.
      // When onError triggers disconnect()+connect(), the old WS close event
      // fires asynchronously and must not trigger a phantom reconnect.
      if (this.ws !== ws) return;

      if (this.connected) {
        this.connected = false;
        this.opts.onDisconnected?.();
      }
      this.stopHeart();
      this.clearStableTimer();

      // Track rapid disconnects: if connection lasted <5s, it's unstable
      if (this.lastConnectTime > 0) {
        const duration = Date.now() - this.lastConnectTime;
        if (duration < 5000) {
          this.rapidDisconnectCount++;
        } else {
          this.rapidDisconnectCount = 0;
        }
        this.lastConnectTime = 0;
      }

      // If 3+ consecutive rapid disconnects, trigger onError for token refresh
      if (this.rapidDisconnectCount >= 3) {
        this.needReconnect = false;
        this.rapidDisconnectCount = 0;
        this.opts.onError?.(new Error("Connect failed: rapid disconnect detected"));
        return;
      }

      if (this.needReconnect) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      if (this.ws !== ws) return; // stale guard
      console.debug("[WKSocket] ws error:", err.message);
      // The 'close' event will follow, which handles reconnect
    });
  }

  private scheduleReconnect(): void {
    this.stopReconnectTimer();
    const baseDelay = 3000;
    const maxDelay = 60000;
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
    // Add ±25% random jitter to prevent thundering herd
    const jitter = exponentialDelay * (0.75 + Math.random() * 0.5);
    const delay = Math.floor(jitter);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (this.needReconnect) {
        this.doConnect();
      }
    }, delay);
  }

  stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startStableTimer(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      if (this.connected) {
        this.reconnectAttempts = 0;
        this.rapidDisconnectCount = 0;
      }
    }, 30_000);
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────────

  private restartHeart(): void {
    this.stopHeart();
    this.pingRetryCount = 0;
    this.heartTimer = setInterval(() => {
      this.pingRetryCount++;
      if (this.pingRetryCount > this.pingMaxRetry) {
        console.debug("[WKSocket] ping timeout, reconnecting...");
        this.stopHeart();
        this.clearStableTimer();
        if (this.ws) {
          try { this.ws.close(); } catch { /* ignore */ }
          this.ws = null;
        }
        if (this.connected) {
          this.connected = false;
          this.opts.onDisconnected?.();
        }
        if (this.needReconnect) {
          this.scheduleReconnect();
        }
        return;
      }
      this.sendRaw(encodePingPacket());
    }, 60_000); // 60s heartbeat interval (matches SDK default)
  }

  private stopHeart(): void {
    if (this.heartTimer) {
      clearInterval(this.heartTimer);
      this.heartTimer = null;
    }
  }

  // ─── Raw Data & Packet Framing ──────────────────────────────────────────

  private sendRaw(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private handleRawData(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) this.tempBuffer.push(data[i]);

    // D1/S6 (齐 P0-1): cap tempBuffer at MAX_TEMP_BUFFER_BYTES to prevent
    // unbounded growth from a malicious/buggy server that sends partial
    // packets indefinitely (e.g. an unending variable-length encoding).
    if (this.tempBuffer.length > MAX_TEMP_BUFFER_BYTES) {
      console.error(
        `[WKSocket] tempBuffer exceeded ${MAX_TEMP_BUFFER_BYTES} bytes (got ${this.tempBuffer.length}) — dropping and reconnecting`,
      );
      this.tempBuffer = [];
      if (this.ws) {
        try { this.ws.close(); } catch { /* ignore */ }
      }
      return;
    }

    try {
      // Parse complete packets using a moving cursor instead of re-slicing the
      // whole buffer per packet. The old `tempBuffer = tempBuffer.slice(total)`
      // per iteration was O(n²): a peer dribbling many tiny frames near the 1 MiB
      // cap forced ~n full-array copies of an ~n-element array, stalling the event
      // loop (shared across bots) without exceeding the byte cap. Now we advance
      // an offset and trim the consumed prefix exactly once at the end.
      let consumed = 0;
      for (;;) {
        const used = this.unpackOne(this.tempBuffer, consumed);
        if (used === 0) break; // incomplete packet — wait for more bytes
        consumed += used;
      }
      if (consumed > 0) {
        this.tempBuffer = this.tempBuffer.slice(consumed);
      }
    } catch (err) {
      console.debug("[WKSocket] decode error:", err);
      // Reset buffer and reconnect
      this.tempBuffer = [];
      if (this.ws) {
        try { this.ws.close(); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Parse ONE packet starting at `start` in `data`. Returns the number of bytes
   * consumed, or 0 if the buffer does not yet hold a complete packet (caller
   * should wait for more bytes). Reads via `start + offset` and slices only the
   * single packet's bytes — never the whole buffer — so repeated calls over a
   * large buffer stay O(n) total, not O(n²).
   */
  private unpackOne(data: number[], start: number): number {
    const available = data.length - start;
    if (available <= 0) return 0;

    const header = data[start];
    const packetType = header >> 4;

    // PONG is a single byte
    if (packetType === PacketType.PONG) {
      this.onPong();
      return 1;
    }
    // PING from server (shouldn't happen but handle gracefully)
    if (packetType === PacketType.PING) {
      return 1;
    }

    const fixedHeaderLength = 1;
    let pos = start + fixedHeaderLength;
    let remLength = 0;
    let multiplier = 1;
    let hasMore = false;
    let remLengthFull = true;

    do {
      if (pos > data.length - 1) {
        remLengthFull = false;
        break;
      }
      // D1/S6 (齐 P0-1): cap at MAX_VARLEN_BYTES per MQTT spec. Without
      // this, a stream of 0x80 bytes would never terminate and would let
      // tempBuffer grow until handleRawData kills the connection — raise
      // earlier and more explicitly here.
      if (pos - (start + fixedHeaderLength) >= MAX_VARLEN_BYTES) {
        throw new Error(
          `[WKSocket] variable-length encoding exceeded ${MAX_VARLEN_BYTES} bytes — malformed packet`,
        );
      }
      const digit = data[pos++];
      remLength += (digit & 127) * multiplier;
      multiplier *= 128;
      hasMore = (digit & 0x80) !== 0;
    } while (hasMore);

    if (!remLengthFull) return 0; // Incomplete frame — need more bytes

    const remLengthLength = pos - (start + fixedHeaderLength);
    const totalLength = fixedHeaderLength + remLengthLength + remLength;

    if (totalLength > available) return 0; // Incomplete packet — need more bytes

    // Extract exactly this one packet's bytes and dispatch.
    const packetData = new Uint8Array(data.slice(start, start + totalLength));
    this.onPacket(packetData);
    return totalLength;
  }

  // ─── Packet Handling ────────────────────────────────────────────────────

  private onPong(): void {
    this.pingRetryCount = 0;
  }

  private onPacket(data: Uint8Array): void {
    const firstByte = data[0];
    const packetType = firstByte >> 4;

    // Skip the header and variable-length bytes to get body
    const dec = new Decoder(data);
    dec.readByte(); // header byte
    if (packetType !== PacketType.PING && packetType !== PacketType.PONG) {
      dec.readVariableLength(); // remaining length
    }

    // WuKongIM header byte layout: [packetType:4][flags:4]
    // Bit 0 of flags has DIFFERENT semantics per packet type:
    //   CONNACK: bit 0 = hasServerVersion (server includes version byte in body)
    //   RECV:    bit 0 = noPersist (message should not be persisted)
    // Bit 1 of flags:
    //   RECV:    bit 1 = reddot (show unread badge)
    switch (packetType) {
      case PacketType.CONNACK: {
        const hasServerVersion = (firstByte & 0x01) > 0;
        this.onConnack(dec, hasServerVersion);
        break;
      }
      case PacketType.RECV: {
        const _noPersist = (firstByte & 0x01) > 0;
        const _reddot = ((firstByte >> 1) & 0x01) > 0;
        this.onRecv(dec, _noPersist, _reddot);
        break;
      }
      case PacketType.DISCONNECT:
        this.onDisconnect(dec);
        break;
      case PacketType.SENDACK:
        // We don't send messages via WS, ignore
        break;
    }
  }

  private onConnack(dec: Decoder, hasServerVersion: boolean): void {
    if (hasServerVersion) {
      this.serverVersion = dec.readByte();
    }
    dec.readInt64BigInt(); // timeDiff (unused)
    const reasonCode = dec.readByte();
    const serverKey = dec.readString();
    const salt = dec.readString();
    if (this.serverVersion >= 4) {
      dec.readInt64BigInt(); // nodeId (unused)
    }

    if (reasonCode === 1) {
      // Success — derive AES key from DH shared secret.
      // A malformed/short salt yields a wrong AES-CBC IV (CryptoJS zero-pads it),
      // which makes EVERY subsequent payload decrypt fail — i.e. a bot that looks
      // connected (heartbeat fine) but silently drops every message. Fail the
      // handshake instead so we reconnect and re-derive, rather than entering
      // that silent-drop state. (serverKey is validated the same way: a bad DH
      // key throws in sharedKey(), caught by handleRawData's try/catch.)
      // The IV needs 16 BYTES, so validate by byte length, not char length: a
      // 16-char salt with multibyte UTF-8 chars is <16 OR >16 bytes and would
      // yield a wrong IV (the same silent-decrypt-failure this guard prevents).
      const saltByteLen = salt ? Buffer.byteLength(salt, "utf8") : 0;
      if (saltByteLen < 16) {
        this.connected = false;
        console.error(
          `[WKSocket] CONNACK salt too short (got ${saltByteLen} bytes, need >=16) — ` +
          `AES IV would be invalid and every message would silently fail to decrypt. ` +
          `Failing the connection to force a fresh handshake.`,
        );
        if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
        // needReconnect stays true (default) so the close handler reconnects.
        this.opts.onError?.(new Error("CONNACK salt too short"));
        return;
      }
      const serverPubKey = Uint8Array.from(Buffer.from(serverKey, "base64"));
      const secret = sharedKey(this.dhPrivateKey!, serverPubKey);
      const secretBase64 = Buffer.from(secret).toString("base64");
      const aesKeyFull = Md5.init(secretBase64);
      this.aesKey = aesKeyFull.substring(0, 16);
      // Take the first 16 BYTES of the salt as the IV (CryptoJS Utf8.parse(aesIV)
      // re-encodes to bytes, so a 16-byte ASCII-equivalent slice is required).
      this.aesIV = Buffer.from(salt, "utf8").subarray(0, 16).toString("latin1");

      this.connected = true;
      this.lastConnectTime = Date.now();
      this.restartHeart();
      this.startStableTimer();
      this.opts.onConnected?.();
    } else if (reasonCode === 0) {
      // Kicked
      this.connected = false;
      this.needReconnect = false;
      if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
      this.opts.onError?.(new Error("Kicked by server"));
      this.opts.onDisconnected?.();
    } else {
      // Connect failed
      this.connected = false;
      this.needReconnect = false;
      this.opts.onError?.(new Error(`Connect failed: reasonCode=${reasonCode}`));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private onRecv(dec: Decoder, _noPersist: boolean, _reddot: boolean): void {
    const settingByte = dec.readByte();
    const setting = parseSettingByte(settingByte);
    dec.readString(); // msgKey (unused)
    const fromUID = dec.readString();
    const channelID = dec.readString();
    const channelType = dec.readByte();
    if (this.serverVersion >= 3) {
      dec.readInt32(); // expire (unused)
    }
    dec.readString(); // clientMsgNo (unused)
    const messageID = dec.readInt64String();
    const messageSeq = dec.readInt32();
    const timestamp = dec.readInt32();
    if (setting.topic) {
      dec.readString(); // topic (unused)
    }
    const encryptedPayload = dec.readRemaining();

    // Decrypt + parse BEFORE acking. RECVACK tells the server "delivered, don't
    // resend" — if we ack first and decrypt then fails (transient key/IV issue),
    // the message is lost forever with only a debug log. By acking only after a
    // successful parse, a transient failure leaves the message un-acked so the
    // server redelivers it. (A *permanent* decrypt failure means the AES key/IV
    // from CONNACK is wrong — onConnack now fails the connection in that case,
    // forcing a fresh handshake rather than a silent-drop or redelivery loop.)
    let payloadObj: Record<string, unknown> | undefined;
    try {
      const decryptedBytes = aesDecrypt(encryptedPayload, this.aesKey, this.aesIV);
      const payloadStr = uintToString(Array.from(decryptedBytes));
      payloadObj = JSON.parse(payloadStr);
    } catch (err) {
      // Count failures per messageID. Below the cap, leave it un-acked so the
      // server redelivers (handles a transient hiccup). At the cap, ack-and-drop
      // this one poison message so it can't wedge the stream forever.
      const fails = (this.decryptFailCounts.get(messageID) ?? 0) + 1;
      if (fails >= MAX_DECRYPT_RETRIES) {
        console.error(
          `[WKSocket] payload decrypt/parse failed ${fails}x for message ${messageID} — ` +
          `ack-and-drop (poison message) so it stops redelivering:`, err,
        );
        this.decryptFailCounts.delete(messageID);
        this.sendRaw(encodeRecvackPacket(messageID, messageSeq));
        return;
      }
      // Bound the map so a flood of distinct failing ids can't grow it forever.
      if (this.decryptFailCounts.size >= MAX_DECRYPT_FAIL_ENTRIES) {
        this.decryptFailCounts.clear();
      }
      this.decryptFailCounts.set(messageID, fails);
      console.error(
        `[WKSocket] payload decrypt/parse error (attempt ${fails}/${MAX_DECRYPT_RETRIES}) — ` +
        `NOT acking so the server can redeliver:`, err,
      );
      return;
    }

    // Parse succeeded — clear any prior failure count and ack.
    this.decryptFailCounts.delete(messageID);
    this.sendRaw(encodeRecvackPacket(messageID, messageSeq));

    // Build MessagePayload (same shape as SDK's contentObj-based output)
    const payload: MessagePayload = {
      type: (payloadObj?.type as MessageType) ?? 0,
      content: payloadObj?.content as string | undefined,
      ...payloadObj,
    };

    const msg: BotMessage = {
      message_id: messageID,
      message_seq: messageSeq,
      from_uid: fromUID,
      channel_id: channelID,
      channel_type: channelType,
      timestamp,
      payload,
      streamOn: setting.streamOn,
    };

    this.opts.onMessage(msg);
  }

  private onDisconnect(dec: Decoder): void {
    dec.readByte(); // reasonCode (unused)
    dec.readString(); // reason (unused)

    this.connected = false;
    this.needReconnect = false;
    this.stopHeart();
    this.clearStableTimer();
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.opts.onError?.(new Error("Kicked by server"));
    this.opts.onDisconnected?.();
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function generateDeviceID(): string {
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
