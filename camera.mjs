// Live camera view: the Blimp app streams its camera and any number of pages
// (/camera) watch it. Pages need no password (the owner's choice: the demo's
// viewers just open the link).
//
// The Blimp app (role=camera, Blimp token) opens the camera only while
// someone watches: the first watcher sends it camera_start, and the last one
// leaving sends camera_stop after a grace period (a page reload doesn't
// restart the camera). The camera has the lowest priority on the Blimp: a
// photo for the AI or a video call takes it, and the stream pauses
// (camera_state paused, reason photo | call) until the camera is free again.
//
// The app encodes with the hardware H.264 encoder and sends binary packets in
// the screen stream's format (screen.mjs): byte 0 flags (1 = codec config,
// 2 = keyframe), bytes 1-8 the presentation time in microseconds, then Annex B
// data. The server keeps the last codec config, so a page that joins
// mid-stream gets it at once and then waits for a keyframe, which it asks the
// camera for.
//
// Camera -> server: info {device}, camera_state {state, reason, width, height,
//                   rotation, kbps}, ping; binary video packets
// Server -> camera: welcome, camera_start, camera_stop, keyframe, congestion
// Page   -> server: watch {on} (a hidden page stops watching), keyframe,
//                   ack {bytes} (video bytes received so far), ping
// Server -> page:   welcome, camera {agent: online|offline, state, reason, ...},
//                   error {error}; binary video packets
//
// camera_state.state: idle | starting | streaming | paused | error
import { PACKET_CONFIG, PACKET_KEY } from "./screen.mjs";

// The camera keeps running this long after the last page stops watching
const STOP_GRACE_MS = 8_000;
// A page further behind than about a second of video (at the measured rate,
// plus room for a keyframe) drops frames until a keyframe. Counted from the
// page's acks: the kernel's send buffer would otherwise hide seconds of delay
// on a slow link.
const BEHIND_SECONDS = 1.0;
const MIN_BEHIND_BYTES = 64 * 1024;
const VIEWER_BACKLOG_BYTES = 768 * 1024;
const KEYFRAME_REQUEST_MS = 400;
const CONGESTION_NOTICE_MS = 1_000;
// A page behind for longer than this is stuck (a frozen tab, a dead link), not
// slow: it stops pulling everyone's bitrate down
const STUCK_MS = 10_000;

export function createCameraHub({ tokenMatches, send, log, stopGraceMs = STOP_GRACE_MS }) {
  let agent = null;
  let device = null;
  // The camera's last reported state (camera_state minus the type)
  let camera = { state: "idle" };
  let config = null;
  let stopTimer = null;
  let lastKeyRequest = 0;
  let lastCongestion = 0;
  // The stream's measured rate (bytes/s, smoothed) and its last keyframe's size
  let rate = 0;
  let rateBytes = 0;
  let rateSince = Date.now();
  let lastKeySize = 0;
  const viewers = new Set();
  const watching = () => [...viewers].filter((v) => v.watching);

  function view() {
    if (!agent) return { type: "camera", agent: "offline", state: "idle", device };
    return { type: "camera", agent: "online", device, ...camera };
  }

  function broadcast() {
    const msg = view();
    for (const v of viewers) send(v, msg);
  }

  function requestKeyframe() {
    const now = Date.now();
    if (now - lastKeyRequest < KEYFRAME_REQUEST_MS) return;
    lastKeyRequest = now;
    send(agent, { type: "keyframe" });
  }

  // Starts the camera when someone watches; stops it a while after nobody does
  function update() {
    const wanted = watching().length > 0;
    if (wanted) {
      clearTimeout(stopTimer);
      stopTimer = null;
      if (agent && !agent.started) {
        agent.started = true;
        log(`camera: start (${watching().length} watching)`);
        send(agent, { type: "camera_start" });
      }
    } else if (agent?.started && !stopTimer) {
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (watching().length || !agent?.started) return;
        agent.started = false;
        log("camera: stop (nobody watching)");
        send(agent, { type: "camera_stop" });
      }, stopGraceMs);
    }
  }

  // Bytes sent to a page that it hasn't confirmed yet
  function behind(v) {
    return v.acked == null ? v.bufferedAmount : v.sentBytes - v.acked;
  }

  function sendVideo(v, data) {
    v.sentBytes += data.length;
    v.send(data, { binary: true });
  }

  function startWatching(ws) {
    if (ws.watching) return;
    ws.watching = true;
    ws.needKey = true;
    if (config) sendVideo(ws, config);
    if (camera.state === "streaming") requestKeyframe();
    update();
  }

  function refuse(ws, error, code, reason) {
    send(ws, { type: "error", error });
    ws.close(code, reason);
  }

  /** A new /ws connection with role camera (the Blimp, with its token) or camera_viewer (a page). */
  function accept(role, ws, params, ip) {
    if (role === "camera") {
      if (!tokenMatches(params.get("token"))) return refuse(ws, "unauthorized", 4001, "unauthorized");
      if (agent) {
        // A reconnecting Blimp replaces its stale connection
        const stale = agent;
        agent = null;
        stale.close(4002, "replaced");
      }
      ws.role = "camera";
      ws.started = false;
      agent = ws;
      camera = { state: "idle" };
      config = null;
      rate = rateBytes = lastKeySize = 0;
      send(ws, { type: "welcome", role: "camera" });
      log(`camera connected (${ip})`);
      broadcast();
      update();
      return;
    }
    ws.role = "camera_viewer";
    ws.watching = false;
    ws.sentBytes = 0;
    ws.acked = null;
    viewers.add(ws);
    send(ws, { type: "welcome", role: "camera_viewer" });
    send(ws, view());
    log(`camera page opened (${ip}; ${viewers.size} open)`);
    if (params.get("watch") !== "0") startWatching(ws);
  }

  function handle(ws, msg) {
    if (ws === agent) {
      switch (msg.type) {
        case "info":
          device = msg.device && typeof msg.device === "object" ? msg.device : null;
          broadcast();
          return;
        case "camera_state": {
          const { type, ...state } = msg;
          const changed = state.state !== camera.state || state.reason !== camera.reason;
          camera = state;
          if (state.state !== "streaming") config = null;
          if (changed) log(`camera: ${state.state}${state.reason ? ` (${state.reason})` : ""}`);
          broadcast();
          return;
        }
        case "ping":
          send(ws, { type: "pong" });
          return;
      }
      return;
    }
    if (!viewers.has(ws)) return;
    switch (msg.type) {
      case "watch":
        if (msg.on === false) {
          ws.watching = false;
          update();
        } else {
          startWatching(ws);
        }
        return;
      case "ack":
        if (Number.isFinite(msg.bytes)) ws.acked = Math.min(msg.bytes, ws.sentBytes);
        return;
      case "keyframe":
        if (ws.watching) {
          ws.needKey = true;
          requestKeyframe();
        }
        return;
      case "ping":
        send(ws, { type: "pong" });
        return;
    }
  }

  /** A video packet from the camera: to every watching page that can take it. */
  function handleBinary(ws, data) {
    if (ws !== agent || data.length < 9) return;
    const flags = data[0];
    if (flags & PACKET_CONFIG) {
      config = Buffer.from(data);
      for (const v of watching()) {
        v.needKey = true;
        if (v.readyState === v.OPEN) sendVideo(v, config);
      }
      return;
    }
    const key = (flags & PACKET_KEY) !== 0;
    if (key) lastKeySize = data.length;
    rateBytes += data.length;
    const now = Date.now();
    if (now - rateSince >= 500) {
      const current = (rateBytes * 1000) / (now - rateSince);
      rate = rate ? rate * 0.6 + current * 0.4 : current;
      rateBytes = 0;
      rateSince = now;
    }
    let congested = false;
    const limit = Math.max(MIN_BEHIND_BYTES, rate * BEHIND_SECONDS + lastKeySize);
    for (const v of watching()) {
      if (v.readyState !== v.OPEN) continue;
      if (!key && v.needKey) continue;
      if (behind(v) > limit || v.bufferedAmount > VIEWER_BACKLOG_BYTES) {
        // This page can't keep up: skip to a keyframe, and tell the camera
        v.needKey = true;
        v.behindSince ||= now;
        if (now - v.behindSince < STUCK_MS) congested = true;
        continue;
      }
      v.behindSince = 0;
      if (key) v.needKey = false;
      sendVideo(v, data);
    }
    if (congested) {
      requestKeyframe();
      if (now - lastCongestion >= CONGESTION_NOTICE_MS) {
        lastCongestion = now;
        send(agent, { type: "congestion" });
      }
    }
  }

  function detach(ws) {
    if (ws === agent) {
      agent = null;
      device = null;
      camera = { state: "idle" };
      config = null;
      clearTimeout(stopTimer);
      stopTimer = null;
      log("camera disconnected");
      broadcast();
    } else if (viewers.delete(ws)) {
      log(`camera page closed (${viewers.size} open)`);
      update();
    }
  }

  function status() {
    return { agent: agent ? "online" : "offline", state: camera.state, viewers: viewers.size,
      watching: watching().length };
  }

  return { accept, handle, handleBinary, detach, status };
}
