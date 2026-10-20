// Stream server for BlimpMate:
// - 1:1 video calls between one Blimp and one remote browser user (/).
// - Remote screen control of the Blimp's Android (/screen; see screen.mjs).
// HTTPS serves the pages; WSS /ws carries presence, call/session control and
// WebRTC signaling. Media flows peer to peer (or through TURN), never here.
import { createServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHmac, timingSafeEqual } from "node:crypto";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createScreenHub } from "./screen.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

const CONFIG = {
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8443),
  certFile: process.env.CERT_FILE || join(ROOT, "certs", "cert.pem"),
  keyFile: process.env.KEY_FILE || join(ROOT, "certs", "key.pem"),
  // The Blimp signs in with this fixed password (built into the Blimp app too);
  // the remote side needs none
  blimpToken: "blimpmate",
  ringSeconds: Number(process.env.RING_SECONDS || 30),
  // Remote screen control: viewers sign in with SCREEN_PASSWORD (unset = off).
  // The agent needs no token: the first device to connect holds the slot.
  screenPassword: process.env.SCREEN_PASSWORD || "",
  heartbeatSeconds: 15,
  // STUN/TURN for the browsers. TURN_SECRET enables coturn's time-limited
  // credentials (use-auth-secret / static-auth-secret).
  // Reachable from mainland China (Google's STUN is not)
  stunUrls: (process.env.STUN_URLS || "stun:stun.miwifi.com:3478,stun:stun.chat.bilibili.com:3478,stun:stun.cloudflare.com:3478")
    .split(",").filter(Boolean),
  turnUrls: (process.env.TURN_URLS || "").split(",").filter(Boolean),
  turnSecret: process.env.TURN_SECRET || "",
  turnTtlSeconds: 12 * 3600,
};

const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".mp3": "audio/mpeg" };

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function iceServers() {
  const servers = [];
  if (CONFIG.stunUrls.length) servers.push({ urls: CONFIG.stunUrls });
  if (CONFIG.turnUrls.length && CONFIG.turnSecret) {
    const username = `${Math.floor(Date.now() / 1000) + CONFIG.turnTtlSeconds}:blimpmate`;
    const credential = createHmac("sha1", CONFIG.turnSecret).update(username).digest("base64");
    servers.push({ urls: CONFIG.turnUrls, username, credential });
  }
  return servers;
}

function tokenMatches(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(CONFIG.blimpToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- state: one blimp, one remote user (later browsers wait in line), one call ----

const peers = { blimp: null, remote: null };
const waitingRemotes = [];
// call.state: idle | ringing | in_call; caller/callee are "blimp" | "remote"
const call = { state: "idle", caller: null, callee: null, ringTimer: null };

const other = (role) => (role === "blimp" ? "remote" : "blimp");

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function presence() {
  const inCall = call.state === "in_call";
  return {
    type: "presence",
    blimp: peers.blimp ? (inCall ? "in_call" : "online") : "offline",
    remote: peers.remote ? (inCall ? "in_call" : "online") : "offline",
  };
}

function broadcastPresence() {
  const msg = presence();
  send(peers.blimp, msg);
  send(peers.remote, msg);
}

// Each side gets its own view of the call: its direction, and on connect who sends the offer
function sendCallState(reason, roles = ["blimp", "remote"]) {
  for (const role of roles) {
    const view = { type: "call", state: call.state };
    if (call.state !== "idle") {
      view.direction = call.caller === role ? "outgoing" : "incoming";
      if (call.state === "in_call") view.offerer = call.caller === role;
    }
    if (reason) view.reason = reason;
    send(peers[role], view);
  }
}

function endCall(reason) {
  if (call.state === "idle") return;
  clearTimeout(call.ringTimer);
  log(`call ended: ${reason}`);
  Object.assign(call, { state: "idle", caller: null, callee: null, ringTimer: null });
  sendCallState(reason);
  broadcastPresence();
}

function handleControl(role, msg) {
  switch (msg.type) {
    case "invite": {
      if (!peers[other(role)]) return send(peers[role], { type: "error", error: "peer_offline" });
      if (call.state === "ringing" && call.callee === role) {
        // Both called each other at once: treat it as an answer
        return handleControl(role, { type: "accept" });
      }
      if (call.state !== "idle") return send(peers[role], { type: "error", error: "busy" });
      Object.assign(call, { state: "ringing", caller: role, callee: other(role) });
      call.ringTimer = setTimeout(() => endCall("no_answer"), CONFIG.ringSeconds * 1000);
      log(`${role} is calling`);
      sendCallState();
      return;
    }
    case "accept": {
      if (call.state !== "ringing" || call.callee !== role) return;
      clearTimeout(call.ringTimer);
      call.state = "in_call";
      log(`${role} answered`);
      sendCallState();
      broadcastPresence();
      return;
    }
    case "decline":
      if (call.state === "ringing" && call.callee === role) endCall("declined");
      return;
    case "hangup":
      if (call.state === "ringing" && call.caller === role) endCall("cancelled");
      else if (call.state === "in_call") endCall("hangup");
      return;
    case "signal":
      // SDP/ICE only flows within an answered call
      if (call.state === "in_call") send(peers[other(role)], { type: "signal", data: msg.data });
      return;
    case "ping":
      send(peers[role], { type: "pong" });
      return;
  }
}

function attach(role, ws) {
  ws.role = role;
  peers[role] = ws;
  send(ws, { type: "welcome", role, iceServers: iceServers(), ringSeconds: CONFIG.ringSeconds });
  log(`${role} connected`);
  broadcastPresence();
  sendCallState(undefined, [role]);
}

function detach(ws) {
  const idx = waitingRemotes.indexOf(ws);
  if (idx >= 0) waitingRemotes.splice(idx, 1);
  if (peers[ws.role] !== ws) return;
  peers[ws.role] = null;
  log(`${ws.role} disconnected`);
  if (call.state !== "idle") endCall("peer_left");
  // The first browser in line becomes the remote user
  if (ws.role === "remote") {
    const next = waitingRemotes.shift();
    if (next) attach("remote", next);
  }
  broadcastPresence();
}

const screenHub = createScreenHub({
  viewerPassword: CONFIG.screenPassword,
  iceServers,
  send,
  log,
});

// ---- HTTPS + WSS ----

const PAGES = { "/": "index.html", "/screen": "screen.html" };

async function serveStatic(req, res) {
  const url = new URL(req.url, "https://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ...presence(), call: call.state, screen: screenHub.status() }));
  }
  // /screen/ -> /screen: the pages use relative links, which break under a trailing slash
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    res.writeHead(301, { location: url.pathname.replace(/\/+$/, "") + url.search });
    return res.end();
  }
  const rel = PAGES[url.pathname] || url.pathname.slice(1);
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !MIME[extname(file)]) {
    res.writeHead(404);
    return res.end("Not found");
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)], "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

if (!existsSync(CONFIG.certFile) || !existsSync(CONFIG.keyFile)) {
  console.error(`TLS certificate missing (${CONFIG.certFile}). Run: npm run cert`);
  process.exit(1);
}
if (!screenHub.enabled) log("Screen control is off (set SCREEN_PASSWORD to turn it on)");

const server = createServer(
  { cert: readFileSync(CONFIG.certFile), key: readFileSync(CONFIG.keyFile) },
  serveStatic
);
// Large enough for a keyframe of the screen stream
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1024 * 1024 });

wss.on("connection", (ws, req) => {
  const params = new URL(req.url, "https://localhost").searchParams;
  const role = params.get("role");
  if (role === "blimp") {
    if (!tokenMatches(params.get("token"))) {
      send(ws, { type: "error", error: "unauthorized" });
      return ws.close(4001, "unauthorized");
    }
    // A reconnecting blimp replaces its stale connection
    if (peers.blimp) {
      const stale = peers.blimp;
      detach(stale);
      stale.close(4002, "replaced");
    }
    attach("blimp", ws);
  } else if (role === "remote") {
    ws.role = "remote";
    if (peers.remote) {
      waitingRemotes.push(ws);
      send(ws, { type: "waiting", position: waitingRemotes.length });
      log(`remote browser waiting (${waitingRemotes.length} in line)`);
    } else {
      attach("remote", ws);
    }
  } else if (role === "screen" || role === "viewer") {
    screenHub.accept(role, ws, params, req.socket.remoteAddress);
    if (ws.readyState !== ws.OPEN) return;
  } else {
    return ws.close(4000, "role required");
  }

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  const screenRole = ws.role === "screen" || ws.role === "viewer";
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (screenRole) screenHub.handleBinary(ws, raw);
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    if (screenRole) return screenHub.handle(ws, msg);
    if (peers[ws.role] !== ws) return; // waiting browsers can't act
    handleControl(ws.role, msg);
  });
  ws.on("close", () => (screenRole ? screenHub.detach(ws) : detach(ws)));
});

// Heartbeat: drop connections that stop answering pings (this is what marks
// the blimp offline when its network dies without a close)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, CONFIG.heartbeatSeconds * 1000);

server.listen(CONFIG.port, CONFIG.host, () => {
  log(`stream server on https://${CONFIG.host}:${CONFIG.port}/ (signaling wss://…/ws)`);
});
