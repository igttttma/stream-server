// Viewer side of remote screen control (protocol in ../screen.mjs). Events:
// "status" (signaling up/down), "welcome", "presence", "session" (idle |
// starting | streaming), "stream", "channel" (input channel open/closed),
// "message" (from the agent over the input channel), "error".
//
// The agent sends the offer with one video track and an "input" data channel;
// this side only answers and receives.

export class ScreenViewer extends EventTarget {
  /** @param {{url: string}} opts  wss://host/ws (role and password are added) */
  constructor({ url }) {
    super();
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.signedIn = false;
    this.iceServers = [];
    this.presence = { agent: "offline", device: null };
    this.session = { state: "idle" };
    this.pc = null;
    this.channel = null;
    this.stream = null;
    this._pendingCandidates = [];
    this._signalChain = Promise.resolve();
    this._reconnectDelay = 500;
    this._closed = true;
  }

  /** True when signed out (never connected, closed, or refused); false while connecting or retrying. */
  get closed() { return this._closed; }

  connect(password) {
    this.password = password;
    this._closed = false;
    const url = new URL(this.url);
    url.searchParams.set("role", "viewer");
    url.searchParams.set("password", password);
    const ws = new WebSocket(url);
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
      // Wrong password, locked out, someone else connected, or the feature is
      // off: retrying won't help
      const fatal = e.code === 4001 || e.code === 4029 || e.code === 4009 || e.code === 4003;
      if (fatal) this._closed = true;
      this.signedIn = false;
      this._setConnected(false, e.reason || `closed (${e.code})`);
      this._teardown();
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
    this._teardown();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close(1000, "viewer closed");
    }
    this._setConnected(false, "viewer closed");
  }

  /** Ask the agent for the screen. */
  start() { return this._send({ type: "screen_start" }); }
  stop() {
    this._teardown();
    return this._send({ type: "screen_stop" });
  }

  /** Sends an input event to the agent; false if the channel isn't open. */
  sendInput(event) {
    if (this.channel?.readyState !== "open") return false;
    this.channel.send(JSON.stringify(event));
    return true;
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
        if (msg.state === "starting") this._startPeer();
        if (msg.state === "idle") this._teardown();
        this._setSession(msg);
        break;
      case "signal":
        this._signalChain = this._signalChain
          .then(() => this._onSignal(msg.data))
          .catch((err) => this._fail("signal", err));
        break;
      case "error":
        this._emit("error", msg);
        break;
    }
  }

  _startPeer() {
    this._teardown();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.stream = new MediaStream();
    pc.ontrack = (e) => {
      // Play as soon as a frame arrives: don't let the jitter buffer pile up
      if ("playoutDelayHint" in e.receiver) e.receiver.playoutDelayHint = 0;
      this.stream.addTrack(e.track);
      this._emit("stream", this.stream);
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      this.channel = ch;
      ch.onopen = () => this._emit("channel", { open: true });
      ch.onclose = () => this.channel === ch && this._emit("channel", { open: false });
      ch.onmessage = (m) => {
        let data;
        try { data = JSON.parse(m.data); } catch { return; }
        this._emit("message", data);
      };
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this._send({ type: "signal", data: { candidate: e.candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      this._emit("connection", { state: pc.connectionState });
      if (pc.connectionState === "failed") this._fail("ice", new Error("connection failed"));
    };
  }

  async _onSignal(data) {
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

  _fail(stage, err) {
    this._emit("error", { error: `${stage}: ${err?.message || err}` });
    this.stop();
  }

  _teardown() {
    if (this.channel) {
      const ch = this.channel;
      this.channel = null;
      ch.onopen = ch.onclose = ch.onmessage = null;
      try { ch.close(); } catch {}
      this._emit("channel", { open: false });
    }
    if (this.pc) {
      this.pc.ontrack = this.pc.ondatachannel = this.pc.onicecandidate = this.pc.onconnectionstatechange = null;
      try { this.pc.close(); } catch {}
      this.pc = null;
    }
    this._pendingCandidates = [];
    if (this.stream) {
      this.stream = null;
      this._emit("stream", null);
    }
  }
}
