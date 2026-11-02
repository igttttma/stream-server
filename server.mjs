// Stream server for BlimpMate:
// - 1:1 video calls between one Blimp and remote browser users (/).
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

// ---- state: one blimp, any number of remote pages, one call ----
// Every browser that opens the page is connected and sees the Blimp's status.
// Only one call runs at a time: pressing Call while one is ringing or in
// progress gets "busy". When the Blimp calls out, every open page rings and
// the first to answer gets the call.

let blimp = null;
const remotes = new Set();
// call.state: idle | ringing | in_call; caller: "blimp" | "remote".
// call.remote: the remote page in the call (null while the Blimp rings every page);
// call.declined: pages that declined the Blimp's ring-to-all
const call = { state: "idle", caller: null, remote: null, declined: new Set(), ringTimer: null };

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

const connected = () => [blimp, ...remotes].filter(Boolean);

// Whether this connection takes part in the current call (ringing counts)
function inCall(ws) {
  if (call.state === "idle") return false;
  if (ws.role === "blimp") return ws === blimp;
  if (call.remote) return ws === call.remote;
  return call.caller === "blimp" && remotes.has(ws) && !call.declined.has(ws);
}
const parties = () => connected().filter(inCall);
const ringingRemotes = () => parties().filter((ws) => ws.role === "remote");

// The Blimp sees whether any remote page is open. A remote page sees the Blimp
// as available unless it is the one in the call: other pages learn the line is
// busy only when they press Call.
function presenceFor(ws) {
  const busy = call.state === "in_call";
  if (ws.role === "blimp") {
    return { type: "presence", blimp: busy ? "in_call" : "online",
      remote: !remotes.size ? "offline" : busy ? "in_call" : "online" };
  }
  const mine = busy && ws === call.remote;
  return { type: "presence", blimp: !blimp ? "offline" : mine ? "in_call" : "online",
    remote: mine ? "in_call" : "online" };
}

function broadcastPresence() {
  for (const ws of connected()) send(ws, presenceFor(ws));
}

// Each side gets its own view of the call: its direction, and on connect who sends the offer
function callView(ws, reason) {
  const view = { type: "call", state: inCall(ws) ? call.state : "idle" };
  if (view.state !== "idle") {
    const outgoing = call.caller === ws.role;
    view.direction = outgoing ? "outgoing" : "incoming";
    if (view.state === "in_call") view.offerer = outgoing;
  }
  if (reason) view.reason = reason;
  return view;
}

function sendCallState(targets = parties()) {
  for (const ws of targets) send(ws, callView(ws));
}

function endCall(reason) {
  if (call.state === "idle") return;
  const was = parties();
  clearTimeout(call.ringTimer);
  log(`call ended: ${reason}`);
  Object.assign(call, { state: "idle", caller: null, remote: null, declined: new Set(), ringTimer: null });
  for (const ws of was) send(ws, callView(ws, reason));
  broadcastPresence();
}

// The Blimp's ring-to-all ends once no page is left ringing
function checkRingToAll() {
  if (call.state === "ringing" && call.caller === "blimp" && !ringingRemotes().length) {
    endCall(call.declined.size ? "declined" : "peer_left");
  }
}

function handleControl(ws, msg) {
  const role = ws.role;
  switch (msg.type) {
    case "invite": {
      if (role === "remote" ? !blimp : !remotes.size) return send(ws, { type: "error", error: "peer_offline" });
      if (call.state === "ringing" && call.caller !== role && inCall(ws)) {
        // Both called each other at once: treat it as an answer
        return handleControl(ws, { type: "accept" });
      }
      if (call.state !== "idle") return send(ws, { type: "error", error: "busy" });
      Object.assign(call, { state: "ringing", caller: role, remote: role === "remote" ? ws : null, declined: new Set() });
      call.ringTimer = setTimeout(() => endCall("no_answer"), CONFIG.ringSeconds * 1000);
      log(`${role} is calling${role === "blimp" ? ` (${remotes.size} page(s) ring)` : ""}`);
      sendCallState();
      return;
    }
    case "accept": {
      if (call.state !== "ringing" || call.caller === role || !inCall(ws)) return;
      clearTimeout(call.ringTimer);
      const others = role === "remote" ? ringingRemotes().filter((r) => r !== ws) : [];
      call.state = "in_call";
      if (role === "remote") call.remote = ws;
      log(`${role} answered`);
      for (const r of others) send(r, callView(r, "answered_elsewhere"));
      sendCallState();
      broadcastPresence();
      return;
    }
    case "decline":
      if (call.state !== "ringing" || call.caller === role || !inCall(ws)) return;
      if (role === "remote" && call.caller === "blimp" && ringingRemotes().length > 1) {
        // Other pages keep ringing
        call.declined.add(ws);
        send(ws, callView(ws));
        return;
      }
      endCall("declined");
      return;
    case "hangup":
      if (!inCall(ws)) return;
      if (call.state === "ringing" && call.caller === role) endCall("cancelled");
      else if (call.state === "in_call") endCall("hangup");
      return;
    case "signal":
      // SDP/ICE only flows within an answered call
      if (call.state === "in_call" && inCall(ws)) {
        send(role === "blimp" ? call.remote : blimp, { type: "signal", data: msg.data });
      }
      return;
    case "ping":
      send(ws, { type: "pong" });
      return;
  }
}

function attach(role, ws) {
  ws.role = role;
  if (role === "blimp") blimp = ws;
  else remotes.add(ws);
  send(ws, { type: "welcome", role, iceServers: iceServers(), ringSeconds: CONFIG.ringSeconds });
  log(`${role} connected${role === "remote" ? ` (${remotes.size} page(s) open)` : ""}`);
  broadcastPresence();
  // A page opened while the Blimp is ringing out rings too
  send(ws, callView(ws));
}

function detach(ws) {
  if (ws.role === "blimp") {
    if (blimp !== ws) return;
    blimp = null;
  } else if (!remotes.delete(ws)) {
    return;
  }
  log(`${ws.role} disconnected`);
  if (ws.role === "blimp" || call.remote === ws) endCall("peer_left");
  else checkRingToAll();
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
    return res.end(JSON.stringify({ ok: true, blimp: blimp ? "online" : "offline", remotes: remotes.size,
      call: call.state, screen: screenHub.status() }));
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
    if (blimp) {
      const stale = blimp;
      detach(stale);
      stale.close(4002, "replaced");
    }
    attach("blimp", ws);
  } else if (role === "remote") {
    attach("remote", ws);
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
    if (ws !== blimp && !remotes.has(ws)) return; // replaced connections can't act
    handleControl(ws, msg);
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
