// Remote screen control: one screen agent (the app on the Blimp's Android) and
// one signed-in viewer that watches and controls it. Whoever connects first
// holds the slot; another agent or viewer is refused until it leaves. The
// server only relays signaling; the video and the input (a WebRTC data
// channel) go peer to peer or through TURN.
//
// Agent  -> server: info {device}, signal {data}, screen_error {error}, ping
// Server -> agent:  welcome, screen_start, screen_stop {reason}, signal {data}
// Viewer -> server: screen_start, screen_stop, signal {data}, ping
// Server -> viewer: welcome, screen_presence {agent, device}, screen {state, reason}, signal {data}, error {error}
//
// screen.state: idle | starting | streaming. The agent sends the offer.
import { timingSafeEqual } from "node:crypto";

const LOCKOUT_FAILURES = 5;
const LOCKOUT_MS = 60_000;

export function secretMatches(secret, given) {
  if (!secret) return false;
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createScreenHub({ viewerPassword, iceServers, send, log }) {
  let agent = null;
  let device = null;
  let viewer = null;
  let state = "idle";
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
      send(ws, { type: "welcome", role: "screen", iceServers: iceServers() });
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
      send(ws, { type: "welcome", role: "viewer", iceServers: iceServers() });
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
        case "signal":
          if (state === "idle") return;
          if (state === "starting") {
            state = "streaming";
            send(viewer, { type: "screen", state: "streaming" });
            send(viewer, presence());
          }
          send(viewer, { type: "signal", data: msg.data });
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
        log("viewer started watching");
        send(ws, { type: "screen", state: "starting" });
        send(agent, { type: "screen_start" });
        send(ws, presence());
        return;
      case "screen_stop":
        endSession("stopped");
        return;
      case "signal":
        if (state !== "idle") send(agent, { type: "signal", data: msg.data });
        return;
      case "ping":
        send(ws, { type: "pong" });
        return;
    }
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

  return { enabled, accept, handle, detach, status };
}
