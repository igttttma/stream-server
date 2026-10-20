// Remote screen control: one screen agent (the app on the Blimp's Android) and
// one signed-in viewer that watches and controls it. Whoever connects first
// holds the slot; another agent or viewer is refused until it leaves.
//
// The agent encodes the screen with the hardware H.264 encoder (scrcpy's
// approach) and sends the packets here as binary messages; the server passes
// them to the viewer, which decodes them with WebCodecs. Input goes the other
// way as JSON.
//
// Agent  -> server: info {device}, viewer {data} (ack/stats for the viewer),
//                   screen_error {error}, ping; binary video packets
// Server -> agent:  welcome, screen_start {preset}, screen_stop {reason}, input {data}, keyframe
// Viewer -> server: screen_start {preset}, screen_stop, input {data}, ping
// Server -> viewer: welcome, screen_presence {agent, device}, screen {state, reason},
//                   agent {data}, error {error}; binary video packets
//
// A video packet: byte 0 flags (1 = codec config: SPS/PPS, 2 = keyframe),
// bytes 1-8 the presentation time in microseconds (big endian), then the
// H.264 Annex B data.
//
// screen.state: idle | starting | streaming (the first packet arrived).
import { timingSafeEqual } from "node:crypto";

const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 60_000;
// More than this waiting to go out to the viewer: drop frames until a
// keyframe, so the picture stays current instead of falling behind
const VIEWER_BACKLOG_BYTES = 1024 * 1024;
export const PACKET_CONFIG = 1;
export const PACKET_KEY = 2;

export function secretMatches(secret, given) {
  if (!secret) return false;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createScreenHub({ viewerPassword, send, log }) {
  let agent = null;
  let device = null;
  let viewer = null;
  let state = "idle";
  // Set when frames were dropped: send nothing but config/keyframes until a keyframe
  let viewerNeedsKey = false;
  // Failed viewer sign-ins per IP, to slow down password guessing
  const failures = new Map();

  const enabled = Boolean(viewerPassword);

  function presence() {
    return { type: "screen_presence", agent: !agent ? "offline" : state === "idle" ? "online" : "streaming", device };
  }

  function endSession(reason, { notifyAgent = true } = {}) {
    if (state === "idle") return;
    log(`screen session ended: ${reason}`);
    state = "idle";
    if (notifyAgent) send(agent, { type: "screen_stop", reason });
    send(viewer, { type: "screen", state: "idle", reason });
    send(viewer, presence());
  }

  function locked(ip) {
    const f = failures.get(ip);
    return f && f.count >= LOCKOUT_FAILURES && Date.now() - f.last < LOCKOUT_MS;
  }

  function noteFailure(ip) {
    const f = failures.get(ip);
    if (!f || Date.now() - f.last >= LOCKOUT_MS) failures.set(ip, { count: 1, last: Date.now() });
    else Object.assign(f, { count: f.count + 1, last: Date.now() });
  }

  function refuse(ws, error, code, reason) {
    send(ws, { type: "error", error });
    ws.close(code, reason);
  }

  /** Handles a new /ws connection with role screen or viewer. */
  function accept(role, ws, params, ip) {
    if (!enabled) return refuse(ws, "screen_disabled", 4003, "screen control is not configured");
    if (role === "screen") {
      // The first device keeps the slot. A dead connection is dropped by the
      // heartbeat within 30 s, and the device's retry then gets in.
      if (agent) {
        log(`screen agent refused (${ip}): another device is connected`);
        return refuse(ws, "agent_connected", 4009, "another device is connected");
      }
      ws.role = "screen";
      agent = ws;
      device = null;
      send(ws, { type: "welcome", role: "screen" });
      log(`screen agent connected (${ip})`);
      send(viewer, presence());
    } else {
      if (locked(ip)) return refuse(ws, "locked", 4029, "too many attempts");
      if (!secretMatches(viewerPassword, params.get("password"))) {
        noteFailure(ip);
        return refuse(ws, "unauthorized", 4001, "unauthorized");
      }
      failures.delete(ip);
      if (viewer) {
        log(`viewer refused (${ip}): someone else is connected`);
        return refuse(ws, "busy", 4009, "someone else is connected");
      }
      ws.role = "viewer";
      viewer = ws;
      send(ws, { type: "welcome", role: "viewer" });
      send(ws, presence());
      send(ws, { type: "screen", state: "idle" });
      log(`viewer signed in (${ip})`);
    }
  }

  function handle(ws, msg) {
    if (ws === agent) {
      switch (msg.type) {
        case "info":
          device = msg.device && typeof msg.device === "object" ? msg.device : null;
          send(viewer, presence());
          return;
        case "viewer":
          if (state !== "idle") send(viewer, { type: "agent", data: msg.data });
          return;
        case "screen_error":
          log(`screen agent error: ${msg.error}`);
          endSession(`agent_error: ${String(msg.error || "unknown").slice(0, 200)}`, { notifyAgent: false });
          return;
        case "ping":
          send(ws, { type: "pong" });
          return;
      }
      return;
    }
    if (ws !== viewer) return;
    switch (msg.type) {
      case "screen_start":
        if (!agent) return send(ws, { type: "error", error: "agent_offline" });
        if (state !== "idle") return;
        state = "starting";
        viewerNeedsKey = false;
        log("viewer started watching");
        send(ws, { type: "screen", state: "starting" });
        send(agent, { type: "screen_start", preset: typeof msg.preset === "string" ? msg.preset : "medium" });
        send(ws, presence());
        return;
      case "screen_stop":
        endSession("stopped");
        return;
      case "input":
        if (state !== "idle") send(agent, { type: "input", data: msg.data });
        return;
      case "ping":
        send(ws, { type: "pong" });
        return;
    }
  }

  /** A binary message: a video packet from the agent. */
  function handleBinary(ws, data) {
    if (ws !== agent || state === "idle" || !viewer || data.length < 9) return;
    if (state === "starting") {
      state = "streaming";
      send(viewer, { type: "screen", state: "streaming" });
      send(viewer, presence());
    }
    const flags = data[0];
    const essential = (flags & (PACKET_CONFIG | PACKET_KEY)) !== 0;
    if (!essential && (viewerNeedsKey || viewer.bufferedAmount > VIEWER_BACKLOG_BYTES)) {
      if (!viewerNeedsKey) {
        viewerNeedsKey = true;
        send(agent, { type: "keyframe" });
      }
      return;
    }
    if (flags & PACKET_KEY) viewerNeedsKey = false;
    if (viewer.readyState === viewer.OPEN) viewer.send(data, { binary: true });
  }

  function detach(ws) {
    if (ws === agent) {
      log("screen agent disconnected");
      endSession("agent_left", { notifyAgent: false });
      agent = null;
      device = null;
      send(viewer, presence());
    } else if (ws === viewer) {
      log("viewer left");
      endSession("viewer_left");
      viewer = null;
    }
  }

  function status() {
    return { enabled, agent: presence().agent, viewer: Boolean(viewer) };
  }

  return { enabled, accept, handle, handleBinary, detach, status };
}
