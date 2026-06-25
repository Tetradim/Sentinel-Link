import test from "node:test";
import assert from "node:assert/strict";
import { NativeMessageDecoder, encodeNativeMessage } from "../src/protocol.js";

test("encodeNativeMessage writes a little-endian length-prefixed JSON frame", () => {
  const frame = encodeNativeMessage({ type: "heartbeat", ok: true });

  const length = frame.readUInt32LE(0);
  const body = JSON.parse(frame.subarray(4).toString("utf8"));

  assert.equal(length, frame.length - 4);
  assert.deepEqual(body, { type: "heartbeat", ok: true });
});

test("NativeMessageDecoder accepts fragmented native message frames", () => {
  const messages = [];
  const decoder = new NativeMessageDecoder((message) => messages.push(message));
  const first = encodeNativeMessage({ id: "one" });
  const second = encodeNativeMessage({ id: "two" });
  const combined = Buffer.concat([first, second]);

  decoder.push(combined.subarray(0, 3));
  decoder.push(combined.subarray(3, 9));
  decoder.push(combined.subarray(9));

  assert.deepEqual(messages, [{ id: "one" }, { id: "two" }]);
});

test("NativeMessageDecoder rejects oversized frames", () => {
  const decoder = new NativeMessageDecoder(() => {}, { maxMessageBytes: 8 });
  const frame = encodeNativeMessage({ text: "too long" });

  assert.throws(() => decoder.push(frame), /Native message too large/);
});
