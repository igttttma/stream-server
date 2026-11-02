// Page side of the live camera view (protocol in ../camera.mjs). Events:
// "status" ({connected, reason}), "camera" (the Blimp's camera state),
// "frame" ({width, height}, every drawn frame), "error" ({error, fatal}).
//
// The Blimp streams H.264 from its hardware encoder; this side decodes it with
// WebCodecs and draws each frame onto a canvas, rotated upright. The stream
// arrives Annex B (start codes); it is repackaged as AVC (length prefixes plus
// an avcC description), which every WebCodecs implementation takes, Safari's
// included. The connection heals by itself: reconnects with backoff, and a
// watchdog asks for a keyframe, then reconnects, when the picture freezes.

const PACKET_CONFIG = 1;
const PACKET_KEY = 2;
// Frames waiting in the decoder beyond this: skip to the next keyframe
const MAX_DECODE_QUEUE = 6;
const FREEZE_KEYFRAME_MS = 3_000;
const FREEZE_RECONNECT_MS = 9_000;
// How often the page tells the server how much video it has received
const ACK_MS = 200;

/** NAL units (without start codes) of an Annex B buffer. */
function splitNals(bytes) {
  const nals = [];
  let start = -1;
  let i = 0;
  while (i + 2 < bytes.length) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        if (end > start && bytes[end - 1] === 0) end--; // the 4-byte start code's leading zero
        nals.push(bytes.subarray(start, end));
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < bytes.length) nals.push(bytes.subarray(start));
  return nals.filter((n) => n.length);
}

const hex = (b) => b.toString(16).padStart(2, "0");

/** avcC box contents from one SPS and one PPS. */
function avcC(sps, pps) {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]);
  out.set(sps, 8);
  let at = 8 + sps.length;
  out.set([1, pps.length >> 8, pps.length & 0xff], at);
  out.set(pps, at + 3);
  return out;
}

/** Length-prefixed (AVC) frame data from NAL units. */
function toAvc(nals) {
  const size = nals.reduce((n, nal) => n + 4 + nal.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const nal of nals) {
    view.setUint32(at, nal.length);
    out.set(nal, at + 4);
    at += 4 + nal.length;
  }
  return out;
}

export class CameraViewer extends EventTarget {
  /** @param {{url: string, canvas: HTMLCanvasElement}} opts  url: wss://host/ws */
  constructor({ url, canvas }) {
    super();
    this.url = url;
    this.canvas = canvas;
    this.ws = null;
    this.connected = false;
    this.camera = { agent: "offline", state: "idle" };
    this.watching = true;
    this.width = 0;
    this.height = 0;
    // For the stats line
    this.framesDrawn = 0;
    this.bytesReceived = 0;
    this.lastFrameAt = 0;
    this._sps = null;
    this._pps = null;
    this._decoder = null;
    this._decoderKey = "";
    this._waitKey = true;
    this._closed = true;
    this._retryMs = 500;
    this._retryTimer = null;
    this._watchdog = null;
    this._keyAskedAt = 0;
  }

  connect(password) {
    this.password = password;
    this._closed = false;
    clearTimeout(this._retryTimer);
    const url = new URL(this.url);
    url.searchParams.set("role", "camera_viewer");
    url.searchParams.set("password", password);
    if (!this.watching) url.searchParams.set("watch", "0");
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    // Counted per connection: the server's count starts over too
    let received = 0;
    let acked = 0;
    const ackTimer = (ws.ackTimer = setInterval(() => {
      if (this.ws !== ws || received === acked) return;
      acked = received;
      this._send({ type: "ack", bytes: received });
    }, ACK_MS));
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this._retryMs = 500;
      this._setConnected(true);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      if (e.data instanceof ArrayBuffer) {
        received += e.data.byteLength;
        return this._onPacket(new Uint8Array(e.data));
      }
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._onMessage(msg);
    };
    ws.onclose = (e) => {
      clearInterval(ackTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this._resetDecoder();
      // Wrong password, locked out, or the feature is off: retrying won't help
      const fatal = e.code === 4001 || e.code === 4029 || e.code === 4003;
      if (fatal) {
        this._closed = true;
        this._emit("error", { error: e.code === 4001 ? "unauthorized" : e.code === 4029 ? "locked" : "disabled", fatal: true });
      }
      this._setConnected(false, e.reason || `closed (${e.code})`);
      if (!this._closed) {
        this._retryTimer = setTimeout(() => !this._closed && this.connect(this.password), this._retryMs);
        this._retryMs = Math.min(this._retryMs * 2, 5_000);
      }
    };
    if (!this._watchdog) this._watchdog = setInterval(() => this._checkFrozen(), 1_000);
  }

  close() {
    this._closed = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._watchdog);
    this._watchdog = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close(1000, "page closed");
    }
    this._resetDecoder();
    this._setConnected(false, "closed");
  }

  /** Reconnects now (the network came back, or the page did). */
  reconnect() {
    if (this._closed) return;
    this._retryMs = 500;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      clearInterval(ws.ackTimer);
      try { ws.close(1000, "reconnect"); } catch {}
      this._resetDecoder();
      this._setConnected(false, "reconnecting");
    }
    this.connect(this.password);
  }

  /** Watching or not (a hidden page stops, so the Blimp's camera can rest). */
  setWatching(on) {
    if (this.watching === on) return;
    this.watching = on;
    this._resetDecoder();
    this._send({ type: "watch", on });
  }

  // ---- internals ----

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _send(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  _setConnected(v, reason) {
    if (this.connected === v) return;
    this.connected = v;
    if (!v) this.camera = { agent: "offline", state: "idle" };
    this._emit("status", { connected: v, reason });
  }

  _onMessage(msg) {
    if (msg.type === "camera") {
      const { type, ...camera } = msg;
      const restarted = camera.state !== "streaming" && this.camera.state === "streaming";
      this.camera = camera;
      // A new camera session sends a new config + keyframe
      if (restarted) this._waitKey = true;
      if (camera.state === "streaming" && !this.lastFrameAt) this.lastFrameAt = performance.now();
      this._emit("camera", camera);
    } else if (msg.type === "error") {
      this._emit("error", { error: msg.error, fatal: false });
    }
  }

  _askKeyframe() {
    const now = performance.now();
    if (now - this._keyAskedAt < 1_000) return;
    this._keyAskedAt = now;
    this._send({ type: "keyframe" });
  }

  // The picture stopped while it should be moving: ask for a keyframe, then reconnect
  _checkFrozen() {
    if (!this.connected || !this.watching || this.camera.state !== "streaming" || document.hidden) {
      this.lastFrameAt = 0;
      return;
    }
    const now = performance.now();
    if (!this.lastFrameAt) {
      this.lastFrameAt = now;
      return;
    }
    const idle = now - this.lastFrameAt;
    if (idle > FREEZE_RECONNECT_MS) {
      this.lastFrameAt = now;
      this.reconnect();
    } else if (idle > FREEZE_KEYFRAME_MS) {
      this._waitKey = true;
      this._askKeyframe();
    }
  }

  _onPacket(packet) {
    if (packet.length < 9 || !this.watching) return;
    this.bytesReceived += packet.length;
    const flags = packet[0];
    const timestamp = Number(new DataView(packet.buffer, packet.byteOffset + 1, 8).getBigInt64(0));
    const nals = splitNals(packet.subarray(9));
    if (flags & PACKET_CONFIG) {
      this._takeParams(nals);
      this._waitKey = true;
      return;
    }
    const key = (flags & PACKET_KEY) !== 0;
    if (key) this._takeParams(nals);
    if (!key && (this._waitKey || !this._decoder)) return;
    if (!key && this._decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // Falling behind: skip to the next keyframe instead of showing old frames
      this._waitKey = true;
      this._askKeyframe();
      return;
    }
    if (key) {
      if (!this._ensureDecoder()) return;
      this._waitKey = false;
    }
    // Parameter sets travel in the description; access unit delimiters aren't needed
    const frame = nals.filter((n) => ![7, 8, 9].includes(n[0] & 0x1f));
    if (!frame.length) return;
    try {
      this._decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: toAvc(frame) }));
    } catch (err) {
      this._decodeFailed(err);
    }
  }

  _takeParams(nals) {
    for (const nal of nals) {
      const type = nal[0] & 0x1f;
      if (type === 7) this._sps = nal.slice();
      else if (type === 8) this._pps = nal.slice();
    }
  }

  // A decoder for the current SPS/PPS (a new one when they change)
  _ensureDecoder() {
    if (!this._sps || !this._pps) {
      this._askKeyframe();
      return false;
    }
    const key = `${[...this._sps].join(",")}|${[...this._pps].join(",")}`;
    if (this._decoder && this._decoderKey === key) return true;
    this._closeDecoder();
    const codec = `avc1.${hex(this._sps[1])}${hex(this._sps[2])}${hex(this._sps[3])}`;
    try {
      const decoder = new VideoDecoder({
        output: (frame) => this._draw(frame),
        error: (err) => this._decoder === decoder && this._decodeFailed(err),
      });
      decoder.configure({ codec, description: avcC(this._sps, this._pps), optimizeForLatency: true });
      this._decoder = decoder;
      this._decoderKey = key;
      return true;
    } catch (err) {
      this._emit("error", { error: `This browser can't play the stream (${codec}): ${err.message}`, fatal: false });
      return false;
    }
  }

  _draw(frame) {
    const rotation = ((Number(this.camera.rotation) || 0) % 360 + 360) % 360;
    const fw = frame.displayWidth, fh = frame.displayHeight;
    const sideways = rotation === 90 || rotation === 270;
    const w = sideways ? fh : fw, h = sideways ? fw : fh;
    const c = this.canvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d");
    if (rotation) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.translate(w / 2, h / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(frame, -fw / 2, -fh / 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      ctx.drawImage(frame, 0, 0);
    }
    frame.close();
    this.framesDrawn++;
    this.lastFrameAt = performance.now();
    this.width = w;
    this.height = h;
    this._emit("frame", { width: w, height: h });
  }

  _decodeFailed(err) {
    this._emit("error", { error: `decode: ${err?.message || err}`, fatal: false });
    this._closeDecoder();
    this._askKeyframe();
  }

  _closeDecoder() {
    if (this._decoder) {
      const d = this._decoder;
      this._decoder = null;
      try { d.close(); } catch {}
    }
    this._decoderKey = "";
    this._waitKey = true;
  }

  _resetDecoder() {
    this._closeDecoder();
    this._sps = this._pps = null;
    this.lastFrameAt = 0;
  }
}

export { splitNals, toAvc, avcC };
