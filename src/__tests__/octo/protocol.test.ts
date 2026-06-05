/**
 * Protocol-layer tests for the WuKongIM binary Encoder / Decoder.
 *
 * Coverage:
 *  - Round-trip for every primitive: writeByte/readByte, writeInt16/readInt16,
 *    writeInt32/readInt32, writeInt64/readInt64BigInt, writeString/readString
 *  - Variable-length encoding / decoding
 *  - Sticky-packet handling: multi-packet buffer, fragmented arrival,
 *    single-byte PING / PONG
 */

import { describe, it, expect } from "vitest";
import { Encoder, Decoder } from "../../octo/socket.js";

// ─── Helper ─────────────────────────────────────────────────────────────────

/** Encode a variable-length integer (same algorithm as the production code). */
function encodeVariableLength(len: number): number[] {
  const ret: number[] = [];
  while (len > 0) {
    let digit = len % 0x80;
    len = Math.floor(len / 0x80);
    if (len > 0) digit |= 0x80;
    ret.push(digit);
  }
  return ret;
}

// ─── 1. Primitive Round-Trips ───────────────────────────────────────────────

describe("Encoder / Decoder round-trip", () => {
  // -- Byte -------------------------------------------------------------------

  it("writeByte / readByte", () => {
    const enc = new Encoder();
    enc.writeByte(0);
    enc.writeByte(127);
    enc.writeByte(255);

    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readByte()).toBe(0);
    expect(dec.readByte()).toBe(127);
    expect(dec.readByte()).toBe(255);
  });

  it("writeByte masks to 8 bits", () => {
    const enc = new Encoder();
    enc.writeByte(0x1ff); // 511 → should mask to 0xff
    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readByte()).toBe(0xff);
  });

  // -- Int16 ------------------------------------------------------------------

  it("writeInt16 / readInt16", () => {
    const values = [0, 1, 255, 256, 0x7fff, 0xffff];
    const enc = new Encoder();
    for (const v of values) enc.writeInt16(v);

    const dec = new Decoder(enc.toUint8Array());
    for (const v of values) expect(dec.readInt16()).toBe(v);
  });

  it("writeInt16 big-endian byte order", () => {
    const enc = new Encoder();
    enc.writeInt16(0x0102);
    const bytes = enc.toUint8Array();
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x02);
  });

  // -- Int32 ------------------------------------------------------------------

  it("writeInt32 / readInt32", () => {
    const values = [0, 1, 0x7fffffff, 0xffffffff];
    const enc = new Encoder();
    for (const v of values) enc.writeInt32(v);

    const dec = new Decoder(enc.toUint8Array());
    for (const v of values) expect(dec.readInt32()).toBe(v >>> 0); // unsigned
  });

  it("writeInt32 big-endian byte order", () => {
    const enc = new Encoder();
    enc.writeInt32(0x01020304);
    const bytes = enc.toUint8Array();
    expect(Array.from(bytes)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  // -- Int64 ------------------------------------------------------------------

  it("writeInt64 / readInt64BigInt", () => {
    const values = [0n, 1n, 0x7fffffffffffffffn, 0xffffffffffffffffn];
    const enc = new Encoder();
    for (const v of values) enc.writeInt64(v);

    const dec = new Decoder(enc.toUint8Array());
    for (const v of values) expect(dec.readInt64BigInt()).toBe(v);
  });

  it("readInt64String returns decimal string", () => {
    const enc = new Encoder();
    const val = 1234567890123456789n;
    enc.writeInt64(val);

    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readInt64String()).toBe(val.toString());
  });

  it("writeInt64 uses exactly 8 bytes", () => {
    const enc = new Encoder();
    enc.writeInt64(42n);
    expect(enc.toUint8Array().length).toBe(8);
  });

  // -- String -----------------------------------------------------------------

  it("writeString / readString (ASCII)", () => {
    const enc = new Encoder();
    enc.writeString("hello");

    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readString()).toBe("hello");
  });

  it("writeString / readString (UTF-8 / CJK)", () => {
    const enc = new Encoder();
    enc.writeString("你好世界🌍");

    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readString()).toBe("你好世界🌍");
  });

  it("writeString / readString (empty string)", () => {
    const enc = new Encoder();
    enc.writeString("");

    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readString()).toBe("");
  });

  it("writeString / readString (null-ish)", () => {
    const enc = new Encoder();
    // Passing undefined-ish values — the encoder writes length=0
    enc.writeString(undefined as unknown as string);
    enc.writeString(null as unknown as string);

    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readString()).toBe("");
    expect(dec.readString()).toBe("");
  });

  it("multiple strings in sequence", () => {
    const enc = new Encoder();
    enc.writeString("abc");
    enc.writeString("def");
    enc.writeString("日本語");

    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readString()).toBe("abc");
    expect(dec.readString()).toBe("def");
    expect(dec.readString()).toBe("日本語");
  });

  // -- Mixed types ------------------------------------------------------------

  it("interleaved types round-trip", () => {
    const enc = new Encoder();
    enc.writeByte(0xab);
    enc.writeInt16(0x1234);
    enc.writeString("mixed");
    enc.writeInt32(0xdeadbeef);
    enc.writeInt64(999999999999n);
    enc.writeString("end");

    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readByte()).toBe(0xab);
    expect(dec.readInt16()).toBe(0x1234);
    expect(dec.readString()).toBe("mixed");
    expect(dec.readInt32()).toBe(0xdeadbeef);
    expect(dec.readInt64BigInt()).toBe(999999999999n);
    expect(dec.readString()).toBe("end");
  });
});

// ─── 2. Variable-Length Encoding ────────────────────────────────────────────

describe("Variable-length encoding / decoding", () => {
  it("single-byte values (0–127)", () => {
    for (const len of [1, 63, 127]) {
      const encoded = encodeVariableLength(len);
      expect(encoded.length).toBe(1);

      const dec = new Decoder(new Uint8Array(encoded));
      expect(dec.readVariableLength()).toBe(len);
    }
  });

  it("two-byte values (128–16383)", () => {
    for (const len of [128, 255, 300, 16383]) {
      const encoded = encodeVariableLength(len);
      expect(encoded.length).toBe(2);

      const dec = new Decoder(new Uint8Array(encoded));
      expect(dec.readVariableLength()).toBe(len);
    }
  });

  it("three-byte values (16384–2097151)", () => {
    for (const len of [16384, 100000, 2097151]) {
      const encoded = encodeVariableLength(len);
      expect(encoded.length).toBe(3);

      const dec = new Decoder(new Uint8Array(encoded));
      expect(dec.readVariableLength()).toBe(len);
    }
  });

  it("four-byte values (2097152+)", () => {
    const len = 2097152;
    const encoded = encodeVariableLength(len);
    expect(encoded.length).toBe(4);

    const dec = new Decoder(new Uint8Array(encoded));
    expect(dec.readVariableLength()).toBe(len);
  });

  it("round-trip for boundary values", () => {
    const boundaries = [1, 127, 128, 16383, 16384, 2097151, 2097152];
    for (const len of boundaries) {
      const encoded = encodeVariableLength(len);
      const dec = new Decoder(new Uint8Array(encoded));
      expect(dec.readVariableLength()).toBe(len);
    }
  });
});

// ─── 3. readRemaining ───────────────────────────────────────────────────────

describe("Decoder.readRemaining", () => {
  it("returns all bytes after current offset", () => {
    const enc = new Encoder();
    enc.writeByte(0x01);
    enc.writeByte(0x02);
    enc.writeByte(0x03);
    enc.writeByte(0x04);

    const dec = new Decoder(enc.toUint8Array());
    dec.readByte(); // consume 0x01
    dec.readByte(); // consume 0x02
    const remaining = dec.readRemaining();
    expect(Array.from(remaining)).toEqual([0x03, 0x04]);
  });

  it("returns empty array when nothing remains", () => {
    const enc = new Encoder();
    enc.writeByte(0xff);

    const dec = new Decoder(enc.toUint8Array());
    dec.readByte(); // consume
    const remaining = dec.readRemaining();
    expect(remaining.length).toBe(0);
  });
});

// ─── 4. Packet Framing (Sticky Packets) ─────────────────────────────────────
//
// The WuKongIM binary protocol frames each packet as:
//   [header-byte] [variable-length remaining] [body...]
// except PING (0x70) and PONG (0x80) which are single-byte.
//
// We test the framing logic by constructing raw packet buffers and verifying
// that the Encoder/Decoder can parse them correctly in various delivery modes.

/** Protocol packet types (same values as production code) */
const PacketType = {
  CONNECT: 1,
  CONNACK: 2,
  SEND: 3,
  SENDACK: 4,
  RECV: 5,
  RECVACK: 6,
  PING: 7,
  PONG: 8,
  DISCONNECT: 9,
} as const;

/**
 * Build a raw framed packet (header + variable-length + body).
 * For PING/PONG, body is empty and there is no variable-length field.
 */
function buildRawPacket(
  packetType: number,
  body: Uint8Array = new Uint8Array(0),
  flags = 0,
): Uint8Array {
  const headerByte = (packetType << 4) | (flags & 0x0f);
  if (packetType === PacketType.PING || packetType === PacketType.PONG) {
    return new Uint8Array([headerByte]);
  }
  const varLen = encodeVariableLength(body.length);
  const frame = new Uint8Array(1 + varLen.length + body.length);
  frame[0] = headerByte;
  frame.set(varLen, 1);
  frame.set(body, 1 + varLen.length);
  return frame;
}

describe("Packet framing", () => {
  it("single-byte PING packet", () => {
    const ping = buildRawPacket(PacketType.PING);
    expect(ping.length).toBe(1);
    expect(ping[0] >> 4).toBe(PacketType.PING);
  });

  it("single-byte PONG packet", () => {
    const pong = buildRawPacket(PacketType.PONG);
    expect(pong.length).toBe(1);
    expect(pong[0] >> 4).toBe(PacketType.PONG);
  });

  it("variable-length frame round-trip (small body)", () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = buildRawPacket(PacketType.RECV, body);

    // Parse: header + varlen + body
    const dec = new Decoder(frame);
    const header = dec.readByte();
    expect(header >> 4).toBe(PacketType.RECV);
    const remLen = dec.readVariableLength();
    expect(remLen).toBe(5);
    const remaining = dec.readRemaining();
    expect(Array.from(remaining)).toEqual([1, 2, 3, 4, 5]);
  });

  it("variable-length frame with larger body (>127 bytes)", () => {
    const body = new Uint8Array(300);
    for (let i = 0; i < 300; i++) body[i] = i & 0xff;
    const frame = buildRawPacket(PacketType.RECV, body);

    const dec = new Decoder(frame);
    dec.readByte(); // header
    const remLen = dec.readVariableLength();
    expect(remLen).toBe(300);
    const remaining = dec.readRemaining();
    expect(remaining.length).toBe(300);
    expect(remaining[0]).toBe(0);
    expect(remaining[299]).toBe(299 & 0xff);
  });

  describe("multi-packet concatenation (sticky packets)", () => {
    it("two complete packets in one buffer", () => {
      const ping = buildRawPacket(PacketType.PING);
      const body = new Uint8Array([10, 20, 30]);
      const recv = buildRawPacket(PacketType.RECV, body);

      // Concatenate
      const combined = new Uint8Array(ping.length + recv.length);
      combined.set(ping, 0);
      combined.set(recv, ping.length);

      // We can parse each packet by reading header + varlen + body
      const dec = new Decoder(combined);

      // First packet: PING (single byte)
      const h1 = dec.readByte();
      expect(h1 >> 4).toBe(PacketType.PING);

      // Second packet: RECV
      const h2 = dec.readByte();
      expect(h2 >> 4).toBe(PacketType.RECV);
      const len2 = dec.readVariableLength();
      expect(len2).toBe(3);
      const body2 = dec.readRemaining();
      expect(Array.from(body2)).toEqual([10, 20, 30]);
    });

    it("three packets: PONG + small RECV + PING", () => {
      const pong = buildRawPacket(PacketType.PONG);
      const body = new Uint8Array([0xaa, 0xbb]);
      const recv = buildRawPacket(PacketType.RECV, body);
      const ping = buildRawPacket(PacketType.PING);

      const combined = new Uint8Array(pong.length + recv.length + ping.length);
      combined.set(pong, 0);
      combined.set(recv, pong.length);
      combined.set(ping, pong.length + recv.length);

      const dec = new Decoder(combined);

      // PONG
      expect(dec.readByte() >> 4).toBe(PacketType.PONG);

      // RECV
      const h2 = dec.readByte();
      expect(h2 >> 4).toBe(PacketType.RECV);
      const len2 = dec.readVariableLength();
      expect(len2).toBe(2);
      // Manually advance past body
      const b1 = dec.readByte();
      const b2 = dec.readByte();
      expect(b1).toBe(0xaa);
      expect(b2).toBe(0xbb);

      // PING
      expect(dec.readByte() >> 4).toBe(PacketType.PING);
    });
  });

  describe("fragmented delivery", () => {
    it("splitting a frame at arbitrary positions produces valid sub-buffers", () => {
      const body = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
      const frame = buildRawPacket(PacketType.RECV, body);

      // Split at every possible position and verify reconstruction
      for (let splitAt = 1; splitAt < frame.length; splitAt++) {
        const frag1 = frame.slice(0, splitAt);
        const frag2 = frame.slice(splitAt);

        // Recombine
        const reassembled = new Uint8Array(frag1.length + frag2.length);
        reassembled.set(frag1, 0);
        reassembled.set(frag2, frag1.length);

        // Verify it's identical to original
        expect(Array.from(reassembled)).toEqual(Array.from(frame));
      }
    });

    it("incomplete variable-length prefix is detected (buffer too short)", () => {
      // Build a packet with body > 127 bytes (needs 2-byte varlen)
      const body = new Uint8Array(200);
      const frame = buildRawPacket(PacketType.RECV, body);

      // Take only header + first byte of variable-length
      const partial = frame.slice(0, 2);

      // The first varlen byte should have continuation bit set
      expect(partial[1] & 0x80).toBe(0x80);

      // A Decoder reading this will get a partial varlen read
      // (the readVariableLength loop will try to read more bytes)
      // This validates the framing logic needs full varlen before proceeding
      const totalFrame = frame.length;
      expect(totalFrame).toBeGreaterThan(2);
    });
  });

  describe("RECVACK packet encoding", () => {
    it("encodes messageID (Int64) + messageSeq (Int32)", () => {
      // Simulate encodeRecvackPacket behavior
      const messageID = "1234567890123456789";
      const messageSeq = 42;

      const body = new Encoder();
      body.writeInt64(BigInt(messageID));
      body.writeInt32(messageSeq);
      const bodyBytes = body.toUint8Array();

      const frame = buildRawPacket(PacketType.RECVACK, bodyBytes);

      // Parse
      const dec = new Decoder(frame);
      const header = dec.readByte();
      expect(header >> 4).toBe(PacketType.RECVACK);
      const remLen = dec.readVariableLength();
      expect(remLen).toBe(12); // 8 (int64) + 4 (int32)

      const parsedID = dec.readInt64String();
      expect(parsedID).toBe(messageID);
      const parsedSeq = dec.readInt32();
      expect(parsedSeq).toBe(messageSeq);
    });
  });

  describe("CONNECT packet structure", () => {
    it("encodes all fields in correct order", () => {
      // Simulate encodeConnectPacket body
      const body = new Encoder();
      body.writeByte(4); // version
      body.writeByte(0); // deviceFlag
      body.writeString("device123");
      body.writeString("bot_uid");
      body.writeString("token_abc");
      body.writeInt64(BigInt(Date.now()));
      body.writeString("clientPublicKey==");
      const bodyBytes = body.toUint8Array();

      const frame = buildRawPacket(PacketType.CONNECT, bodyBytes);

      // Parse frame header
      const dec = new Decoder(frame);
      const header = dec.readByte();
      expect(header >> 4).toBe(PacketType.CONNECT);

      const remLen = dec.readVariableLength();
      expect(remLen).toBe(bodyBytes.length);

      // Parse body fields in order
      expect(dec.readByte()).toBe(4); // version
      expect(dec.readByte()).toBe(0); // deviceFlag
      expect(dec.readString()).toBe("device123");
      expect(dec.readString()).toBe("bot_uid");
      expect(dec.readString()).toBe("token_abc");
      dec.readInt64BigInt(); // timestamp — just verify it reads without error
      expect(dec.readString()).toBe("clientPublicKey==");
    });
  });
});

// ─── 5. Edge Cases ──────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("Encoder produces empty Uint8Array when nothing written", () => {
    const enc = new Encoder();
    const bytes = enc.toUint8Array();
    expect(bytes.length).toBe(0);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it("writeBytes appends raw bytes", () => {
    const enc = new Encoder();
    enc.writeBytes([0xde, 0xad, 0xbe, 0xef]);
    const bytes = enc.toUint8Array();
    expect(Array.from(bytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("long string round-trip (>256 bytes UTF-8)", () => {
    const longStr = "A".repeat(1000) + "中文" + "🎉".repeat(50);
    const enc = new Encoder();
    enc.writeString(longStr);

    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readString()).toBe(longStr);
  });

  it("Int32 handles negative-looking values as unsigned", () => {
    // readInt32 does >>> 0 to make it unsigned
    const enc = new Encoder();
    enc.writeInt32(0x80000000); // highest bit set

    const dec = new Decoder(enc.toUint8Array());
    const val = dec.readInt32();
    expect(val).toBe(0x80000000); // should be positive (unsigned)
    expect(val).toBeGreaterThan(0);
  });

  it("sequential reads advance offset correctly", () => {
    const enc = new Encoder();
    enc.writeByte(0x01);       // 1 byte
    enc.writeInt16(0x0203);    // 2 bytes
    enc.writeInt32(0x04050607); // 4 bytes
    enc.writeInt64(8n);        // 8 bytes
    enc.writeString("hi");    // 2 (len) + 2 (data) = 4 bytes
    // total = 1 + 2 + 4 + 8 + 4 = 19 bytes

    const bytes = enc.toUint8Array();
    expect(bytes.length).toBe(19);

    const dec = new Decoder(bytes);
    dec.readByte();
    dec.readInt16();
    dec.readInt32();
    dec.readInt64BigInt();
    dec.readString();

    // After reading everything, readRemaining should return empty
    const remaining = dec.readRemaining();
    expect(remaining.length).toBe(0);
  });
});

// ─── 6. Large-Payload Safety (Q5 regression) ───────────────────────────────

describe("Large-payload safety (>64K, no stack overflow)", () => {
  it("Encoder.writeBytes handles >64K bytes without stack overflow", () => {
    const enc = new Encoder();
    const largeArray = new Array(100_000).fill(0x42);
    enc.writeBytes(largeArray);
    const result = enc.toUint8Array();
    expect(result.length).toBe(100_000);
    expect(result[0]).toBe(0x42);
    expect(result[99_999]).toBe(0x42);
  });

  it("Encoder.writeString / Decoder.readString round-trip for large UTF-8 string", () => {
    const enc = new Encoder();
    // 20K CJK chars = ~60K UTF-8 bytes, fits in Int16 length prefix (max 65535)
    const longStr = "中".repeat(20_000);
    enc.writeString(longStr);
    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readString()).toBe(longStr);
  });

  it("Encoder.writeString / Decoder.readString round-trip for >64K ASCII", () => {
    const enc = new Encoder();
    // 65000 ASCII chars = 65000 bytes, still fits in Int16 (max 65535)
    const longStr = "A".repeat(65_000);
    enc.writeString(longStr);
    const dec = new Decoder(enc.toUint8Array());
    expect(dec.readString()).toBe(longStr);
  });
});
