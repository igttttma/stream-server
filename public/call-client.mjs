// Signaling + WebRTC for one side of a call (the remote page and the Blimp
// client both use this). Events: "status" (signaling up/down), "welcome"
// (this client now holds its role), "presence",
// "call" (state changes), "waiting", "local-stream", "remote-stream", "error".
//
// Media is acquired only once the call is answered (state "in_call"), so a
// ringing device keeps its microphone for other uses (e.g. a wake-word engine).

const DEFAULT_MEDIA = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
};

export class CallClient extends EventTarget {
  /**
   * @param {object} opts
   * @param {string} opts.url  wss://host/ws?role=remote  (or role=blimp&token=…)
   * @param {() => Promise<MediaStream>} [opts.getMedia]  override media capture
   * @param {number} [opts.disconnectGraceMs]  end the call after ICE stays disconnected this long
   */
  constructor({ url, getMedia, disconnectGraceMs = 10000 }) {
    super();
    this.url = url;
    this.getMedia = getMedia || (() => navigator.mediaDevices.getUserMedia(DEFAULT_MEDIA));
    this.disconnectGraceMs = disconnectGraceMs;
    this.ws = null;
    this.connected = false;
    this.iceServers = [];
    this.presence = { blimp: "offline", remote: "offline" };
    this.call = { state: "idle" };
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this._mediaPromise = null;
    this._pendingCandidates = [];
    this._signalChain = Promise.resolve();
    this._disconnectTimer = null;
    this._reconnectDelay = 500;
    this._closed = false;
  }

  // ---- signaling connection ----

  connect() {
    this._closed = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this._reconnectDelay = 500;
      this._setConnected(true);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._setConnected(false, e.reason || `closed (${e.code})`);
      this._teardownMedia();
      this._setCall({ state: "idle", reason: this.call.state === "idle" ? undefined : "connection_lost" });
      if (e.code === 4001) return this._emit("error", { error: "unauthorized" });
      // Another client signed in as this role; reconnecting would just kick it back out
      if (e.code === 4002) return this._emit("error", { error: "replaced" });
      if (!this._closed) {
        setTimeout(() => !this._closed && this.connect(), this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, 5000);
      }
    };
  }

  close() {
    this._closed = true;
    this._teardownMedia();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close(1000, "client closed");
    }
    this._setConnected(false, "client closed");
  }

  // ---- call control ----

  invite() { return this._send({ type: "invite" }); }
  accept() { return this._send({ type: "accept" }); }
  decline() { return this._send({ type: "decline" }); }
  hangup() { return this._send({ type: "hangup" }); }

  /** Optional: capture media early (e.g. on a button press, to get the permission prompt in). */
  ensureMedia() {
    if (!this._mediaPromise) {
      this._mediaPromise = this.getMedia().then((stream) => {
        this.localStream = stream;
        this._emit("local-stream", stream);
        return stream;
      });
      this._mediaPromise.catch(() => { this._mediaPromise = null; });
    }
    return this._mediaPromise;
  }

  /** Stop media captured with ensureMedia() when no call follows (e.g. the invite failed). */
  releaseMedia() {
    if (this.call.state === "idle") this._teardownMedia();
  }

  setMicEnabled(on) {
    for (const t of this.localStream?.getAudioTracks() || []) t.enabled = on;
  }

  setCameraEnabled(on) {
    for (const t of this.localStream?.getVideoTracks() || []) t.enabled = on;
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

  _setCall(view) {
    const prev = this.call;
    this.call = view;
    if (prev.state !== view.state || view.reason) this._emit("call", { ...view, previous: prev.state });
  }

  _onMessage(msg) {
    switch (msg.type) {
      case "welcome":
        this.role = msg.role;
        this.iceServers = msg.iceServers || [];
        this.ringSeconds = msg.ringSeconds;
        this._emit("welcome", msg);
        break;
      case "waiting":
        this._emit("waiting", msg);
        break;
      case "presence":
        this.presence = { blimp: msg.blimp, remote: msg.remote };
        this._emit("presence", this.presence);
        break;
      case "call":
        if (msg.state === "in_call" && this.call.state !== "in_call") {
          this._setCall(msg);
          this._startPeer(msg.offerer).catch((err) => this._fail("media", err));
        } else if (msg.state === "idle") {
          this._teardownMedia();
          this._setCall(msg);
        } else {
          this._setCall(msg);
        }
        break;
      case "signal":
        // Serialize: an offer can arrive before our own media is ready
        this._signalChain = this._signalChain
          .then(() => this._onSignal(msg.data))
          .catch((err) => this._fail("signal", err));
        break;
      case "error":
        this._emit("error", msg);
        break;
    }
  }

  async _startPeer(offerer) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.remoteStream = new MediaStream();
    pc.ontrack = (e) => {
      this.remoteStream.addTrack(e.track);
      this._emit("remote-stream", this.remoteStream);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this._send({ type: "signal", data: { candidate: e.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => this._onConnectionState(pc);

    // The answerer waits on this promise in _onSignal before applying the offer
    this._peerReady = (async () => {
      const stream = await this.ensureMedia();
      if (this.pc !== pc) return;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    })();
    await this._peerReady;
    if (offerer && this.pc === pc) {
      await pc.setLocalDescription(await pc.createOffer());
      this._send({ type: "signal", data: { description: pc.localDescription.toJSON() } });
    }
  }

  async _onSignal(data) {
    if (!this.pc) return;
    await this._peerReady;
    const pc = this.pc;
    if (!pc) return;
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

  _onConnectionState(pc) {
    if (this.pc !== pc) return;
    this._emit("connection", { state: pc.connectionState });
    clearTimeout(this._disconnectTimer);
    if (pc.connectionState === "failed") {
      this._fail("ice", new Error("connection failed"));
    } else if (pc.connectionState === "disconnected") {
      this._disconnectTimer = setTimeout(() => {
        if (this.pc === pc && pc.connectionState !== "connected") this._fail("ice", new Error("connection lost"));
      }, this.disconnectGraceMs);
    }
  }

  _fail(stage, err) {
    this._emit("error", { error: `${stage}: ${err?.message || err}` });
    this.hangup();
    this._teardownMedia();
  }

  _teardownMedia() {
    clearTimeout(this._disconnectTimer);
    if (this.pc) {
      this.pc.ontrack = this.pc.onicecandidate = this.pc.onconnectionstatechange = null;
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this._peerReady = null;
    this._pendingCandidates = [];
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
      this._emit("local-stream", null);
    }
    this._mediaPromise = null;
    if (this.remoteStream) {
      this.remoteStream = null;
      this._emit("remote-stream", null);
    }
  }
}
