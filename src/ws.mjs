// Minimal RFC 6455 WebSocket helpers (Node built-ins only). Adapted from turbo-browser-mcp's cdp-bridge.
import crypto from 'node:crypto';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Encode a UTF-8 string or Buffer into an RFC 6455 WebSocket frame.
 * Set `mask = true` for client-to-server frames, `false` for server-to-client frames.
 */
export function encodeWsFrame(payload, opcode = 0x01, mask = false) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = data.length;
  const maskBit = mask ? 0x80 : 0x00;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) {
    return Buffer.concat([header, data]);
  }
  const maskKey = crypto.randomBytes(4);
  const maskedData = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    maskedData[i] = data[i] ^ maskKey[i & 3];
  }
  return Buffer.concat([header, maskKey, maskedData]);
}

/**
 * Minimal RFC 6455 WebSocket connection wrapper for upgraded HTTP sockets.
 */
export class WsConnection {
  constructor(socket, { maskOutgoing = false, initialChunk = null } = {}) {
    this.socket = socket;
    this.maskOutgoing = maskOutgoing;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._handleClose());
    socket.on('end', () => this._handleClose());
    socket.on('error', () => this._handleClose());
    if (initialChunk && initialChunk.length > 0) {
      this._onData(initialChunk);
    }
  }

  _onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalFrameLen = offset + maskLen + payloadLen;
      if (this.buffer.length < totalFrameLen) return;

      const payload = Buffer.from(this.buffer.subarray(offset + maskLen, totalFrameLen));
      if (masked) {
        const maskKey = this.buffer.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }
      this.buffer = this.buffer.subarray(totalFrameLen);

      if (opcode === 0x08) {
        // Close frame
        this.close();
        return;
      }
      if (opcode === 0x09) {
        // Ping -> Pong
        if (!this.closed) {
          this.socket.write(encodeWsFrame(payload, 0x0a, this.maskOutgoing));
        }
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }

      if (opcode === 0x01 || opcode === 0x02) {
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      } else if (opcode === 0x00) {
        this.fragments.push(payload);
      }

      if (fin && (this.fragmentOpcode === 0x01 || this.fragmentOpcode === 0x02)) {
        const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentOpcode = 0;
        if (this.onMessage) {
          this.onMessage(full.toString('utf8'));
        }
      }
    }
  }

  send(text) {
    if (this.closed || !this.socket.writable) return;
    try {
      this.socket.write(encodeWsFrame(text, 0x01, this.maskOutgoing));
    } catch {
      this._handleClose();
    }
  }

  close(code = 0, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      let body = Buffer.alloc(0);
      if (code) {
        body = Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), Buffer.from(String(reason).slice(0, 100), 'utf8')]);
      }
      this.socket.end(encodeWsFrame(body, 0x08, this.maskOutgoing));
    } catch {
      this.socket.destroy();
    }
    this._handleClose();
  }

  _handleClose() {
    if (this.closed && !this.onClose) return;
    this.closed = true;
    const cb = this.onClose;
    this.onClose = null;
    if (cb) cb();
  }
}
