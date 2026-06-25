const defaultMaxMessageBytes = 1024 * 1024;

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  constructor(onMessage, options = {}) {
    if (typeof onMessage !== "function") {
      throw new TypeError("onMessage must be a function");
    }
    this.onMessage = onMessage;
    this.maxMessageBytes = options.maxMessageBytes ?? defaultMaxMessageBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxMessageBytes) {
        throw new Error(`Native message too large: ${length} bytes`);
      }
      if (this.buffer.length < length + 4) {
        return;
      }

      const body = this.buffer.subarray(4, 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(4 + length);
      this.onMessage(JSON.parse(body));
    }
  }
}
