// Viewer side of remote screen control (protocol in ../screen.mjs). Events:
// "status" (signaling up/down), "welcome", "presence", "session" (idle |
// starting | streaming), "video" ({width, height} of the picture, on the first
// frame and on size changes), "message" (from the agent: acks, stats), "error".
//
// The agent streams H.264 (hardware encoded on the device); this side decodes
// it with WebCodecs and draws each frame onto the canvas given to attach().
// The packets come through the server, or directly over a WebRTC data channel
// once the agent has one open ("path" event: relay | p2p); while the direct
// path works, packets still arriving through the server are ignored.

const PACKET_CONFIG = 1;
const PACKET_KEY = 2;
// Frames waiting in the decoder beyond this: skip to the next keyframe
const MAX_DECODE_QUEUE = 8;

/** "avc1.PPCCLL" from the SPS in an Annex B config packet (profile, constraints, level). */
function codecFromConfig(bytes) {
  for (let i = 0; i + 4 < bytes.length; i++) {
    const startCode = bytes[i] === 0 && bytes[i + 1] === 0 &&
      (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1));
    if (!startCode) continue;
    const nal = i + (bytes[i + 2] === 1 ? 3 : 4);
    if ((bytes[nal] & 0x1f) === 7 && nal + 3 < bytes.length) {
      const hex = (b) => b.toString(16).padStart(2, "0");
      return `avc1.${hex(bytes[nal + 1])}${hex(bytes[nal + 2])}${hex(bytes[nal + 3])}`;
    }
  }
  return null;
}

export class ScreenViewer extends EventTarget {
  /** @param {{url: string}} opts  wss://host/ws (role and password are added) */
  constructor({ url }) {
    super();
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.signedIn = false;
    this.presence = { agent: "offline", device: null };
    this.session = { state: "idle" };
    this.canvas = null;
    this.width = 0;
    this.height = 0;
    // Counters for the stats line
    this.framesDecoded = 0;
    this.bytesReceived = 0;
    this._decoder = null;
    this._codec = null;
    this._config = null;
    this._waitKey = true;
    // Direct path: the agent's data channel, and the packet being reassembled from it
    this.iceServers = [];
    this.pc = null;
    this.path = "relay";
    this._fragments = [];
    this._reconnectDelay = 500;
    this._closed = true;
  }

  /** True when signed out (never connected, closed, or refused); false while connecting or retrying. */
  get closed() { return this._closed; }

  /** The canvas the screen is drawn on. */
  attach(canvas) {
    this.canvas = canvas;
  }

  connect(password) {
    this.password = password;
    this._closed = false;
    const url = new URL(this.url);
    url.searchParams.set("role", "viewer");
    url.searchParams.set("password", password);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this._reconnectDelay = 500;
      this._setConnected(true);
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        // Through the server: ignored while the direct path delivers
        if (this.path !== "p2p") this._onPacket(new Uint8Array(e.data));
        return;
      }
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Wrong password, locked out, someone else connected, or the feature is
      // off: retrying won't help
      const fatal = e.code === 4001 || e.code === 4029 || e.code === 4009 || e.code === 4003;
      if (fatal) this._closed = true;
      this.signedIn = false;
      this._setConnected(false, e.reason || `closed (${e.code})`);
      this._resetVideo();
      this._setSession({ state: "idle", reason: this.session.state === "idle" ? undefined : "connection_lost" });
      if (!this._closed) {
        setTimeout(() => !this._closed && this.connect(this.password), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 5000);
      }
    };
  }

  close() {
    this._closed = true;
    this.signedIn = false;
    this._resetVideo();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close(1000, "viewer closed");
    }
    this._setConnected(false, "viewer closed");
  }

  /** Ask the agent for the screen at a quality preset (low | medium | high). */
  start(preset = "medium") {
    this._resetVideo();
    return this._send({ type: "screen_start", preset });
  }

  stop() {
    this._resetVideo();
    return this._send({ type: "screen_stop" });
  }

  /** Sends an input event to the agent; false if no session is running. */
  sendInput(event) {
    if (this.session.state === "idle") return false;
    return this._send({ type: "input", data: event });
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
    this._emit("status", { connected: v, reason });
  }

  _setSession(view) {
    const prev = this.session;
    this.session = view;
    if (prev.state !== view.state || view.reason) this._emit("session", { ...view, previous: prev.state });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case "welcome":
        this.signedIn = true;
        this.iceServers = msg.iceServers || [];
        this._emit("welcome", msg);
        break;
      case "screen_presence":
        this.presence = { agent: msg.agent, device: msg.device };
        this._emit("presence", this.presence);
        break;
      case "screen":
        if (msg.state === "idle") this._resetVideo();
        if (msg.state === "starting") this._startPeer();
        this._setSession(msg);
        break;
      case "signal":
        this._signalChain = (this._signalChain || Promise.resolve())
          .then(() => this._onSignal(msg.data))
          .catch(() => this._closePeer());
        break;
      case "agent":
        if (msg.data && typeof msg.data === "object") this._emit("message", msg.data);
        break;
      case "error":
        this._emit("error", msg);
        break;
    }
  }

  // ---- direct path (WebRTC data channel; the agent offers) ----

  _startPeer() {
    this._closePeer();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this._pendingCandidates = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) this._send({ type: "signal", data: { candidate: e.candidate.toJSON() } });
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      ch.binaryType = "arraybuffer";
      // Each message is a fragment: byte 0 is 1 on the last one, then a slice of the packet
      ch.onmessage = (m) => {
        if (this.pc !== pc) return;
        const frag = new Uint8Array(m.data);
        this._fragments.push(frag.subarray(1));
        if (frag[0] !== 1) return;
        const size = this._fragments.reduce((n, f) => n + f.length, 0);
        const packet = new Uint8Array(size);
        let at = 0;
        for (const f of this._fragments) { packet.set(f, at); at += f.length; }
        this._fragments = [];
        this._setPath("p2p");
        this._onPacket(packet);
      };
      ch.onclose = () => this.pc === pc && this._fallBack();
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) this._fallBack();
    };
  }

  async _onSignal(data) {
    const pc = this.pc;
    if (!pc || !data) return;
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      for (const c of this._pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (data.description.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        this._send({ type: "signal", data: { description: pc.localDescription.toJSON() } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else this._pendingCandidates.push(data.candidate);
    }
  }

  // The direct path broke: back to the server's packets, from the next keyframe
  _fallBack() {
    if (this.path !== "p2p") return;
    this._fragments = [];
    this._waitKey = true;
    this._setPath("relay");
    this.sendInput({ t: "keyframe" });
  }

  _setPath(path) {
    if (this.path === path) return;
    this.path = path;
    this._emit("path", { path });
  }

  _closePeer() {
    if (this.pc) {
      const pc = this.pc;
      this.pc = null;
      pc.onicecandidate = pc.ondatachannel = pc.onconnectionstatechange = null;
      try { pc.close(); } catch {}
    }
    this._fragments = [];
    this._setPath("relay");
  }

  // ---- video ----

  _onPacket(packet) {
    if (packet.length < 9) return;
    this.bytesReceived += packet.length;
    const flags = packet[0];
    const timestamp = Number(new DataView(packet.buffer, packet.byteOffset + 1, 8).getBigInt64(0));
    const data = packet.subarray(9);
    if (flags & PACKET_CONFIG) {
      // SPS/PPS: kept and put in front of the next keyframe
      this._config = data.slice();
      const codec = codecFromConfig(this._config);
      if (codec && codec !== this._codec) {
        this._codec = codec;
        this._closeDecoder();
      }
      return;
    }
    const key = (flags & PACKET_KEY) !== 0;
    if (!key && (this._waitKey || !this._decoder)) return;
    if (!key && this._decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // Falling behind: skip to the next keyframe instead of showing old frames
      this._waitKey = true;
      this.sendInput({ t: "keyframe" });
      return;
    }
    if (key) {
      if (!this._codec) return;
      if (!this._decoder) this._openDecoder();
      this._waitKey = false;
    }
    let chunkData = data;
    if (key && this._config) {
      chunkData = new Uint8Array(this._config.length + data.length);
      chunkData.set(this._config);
      chunkData.set(data, this._config.length);
    }
    try {
      this._decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: chunkData }));
    } catch (err) {
      this._decodeFailed(err);
    }
  }

  _openDecoder() {
    this._decoder = new VideoDecoder({
      output: (frame) => this._draw(frame),
      error: (err) => this._decodeFailed(err),
    });
    // No description: the stream is Annex B (start codes), as Android's encoder writes it
    this._decoder.configure({ codec: this._codec, optimizeForLatency: true });
  }

  _draw(frame) {
    const w = frame.displayWidth, h = frame.displayHeight;
    if (this.canvas) {
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.canvas.getContext("2d").drawImage(frame, 0, 0);
    }
    frame.close();
    this.framesDecoded++;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this._emit("video", { width: w, height: h });
    }
  }

  _decodeFailed(err) {
    this._emit("error", { error: `decode: ${err?.message || err}` });
    this._closeDecoder();
    this.sendInput({ t: "keyframe" });
  }

  _closeDecoder() {
    if (this._decoder) {
      try { this._decoder.close(); } catch {}
      this._decoder = null;
    }
    this._waitKey = true;
  }

  _resetVideo() {
    this._closePeer();
    this._closeDecoder();
    this._config = null;
    this._codec = null;
    if (this.width || this.height) {
      this.width = this.height = 0;
      this._emit("video", null);
    }
  }
}
