// Signaling/presence tests against a real server instance (self-signed TLS).
// Run: npm test   (starts its own server on a spare port)
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18443;
const TOKEN = "test-token";
const PASSWORD = "viewer-pass";

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", BLIMP_TOKEN: TOKEN, RING_SECONDS: "1",
    SCREEN_PASSWORD: PASSWORD },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("stream server on") && resolve());
  server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
});

class Peer {
  constructor(query) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws?${query}`, { rejectUnauthorized: false });
    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => !(w.match(msg) && (w.resolve(msg), true)));
    });
    this.closed = new Promise((r) => this.ws.on("close", (code) => r(code)));
  }
  // Resolves with the next matching message (including ones already received and not consumed)
  next(match, timeoutMs = 3000) {
    const pred = typeof match === "function" ? match : (m) => Object.entries(match).every(([k, v]) => m[k] === v);
    const idx = this.messages.findIndex(pred);
    if (idx >= 0) return Promise.resolve(this.messages.splice(0, idx + 1).pop());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${JSON.stringify(match)}; got ${JSON.stringify(this.messages)}`)), timeoutMs);
      this.waiters.push({
        match: pred,
        resolve: (m) => {
          clearTimeout(timer);
          this.messages.splice(this.messages.indexOf(m), 1);
          resolve(m);
        },
      });
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  close() { this.ws.close(); return this.closed; }
  drain() { this.messages.length = 0; }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("blimp with a wrong token is rejected", async () => {
  const bad = new Peer("role=blimp&token=nope");
  assert.equal((await bad.next({ type: "error" })).error, "unauthorized");
  assert.equal(await bad.closed, 4001);
});

test("presence: remote sees the blimp come online and go offline", async () => {
  const remote = new Peer("role=remote");
  const w = await remote.next({ type: "welcome" });
  assert.ok(Array.isArray(w.iceServers));
  assert.equal((await remote.next({ type: "presence" })).blimp, "offline");
  const blimp = new Peer(`role=blimp&token=${TOKEN}`);
  await remote.next({ type: "presence", blimp: "online", remote: "online" });
  await blimp.close();
  await remote.next({ type: "presence", blimp: "offline" });
  await remote.close();
});

test("only the first browser is the remote user; the next one waits and is promoted", async () => {
  const first = new Peer("role=remote");
  await first.next({ type: "welcome" });
  const second = new Peer("role=remote");
  assert.equal((await second.next({ type: "waiting" })).position, 1);
  // A waiting browser can't place calls
  const blimp = new Peer(`role=blimp&token=${TOKEN}`);
  await blimp.next({ type: "presence", remote: "online" });
  second.send({ type: "invite" });
  first.send({ type: "ping" });
  await first.next({ type: "pong" });
  assert.ok(!blimp.messages.some((m) => m.type === "call" && m.state === "ringing"));
  await first.close();
  await second.next({ type: "welcome", role: "remote" });
  await second.close();
  await blimp.close();
});

async function pair() {
  const blimp = new Peer(`role=blimp&token=${TOKEN}`);
  await blimp.next({ type: "welcome" });
  const remote = new Peer("role=remote");
  await remote.next({ type: "welcome" });
  await blimp.next({ type: "presence", remote: "online" });
  blimp.drain();
  remote.drain();
  return { blimp, remote };
}

test("remote calls, blimp answers, signals relay, hang up", async () => {
  const { blimp, remote } = await pair();
  remote.send({ type: "invite" });
  assert.equal((await blimp.next({ type: "call", state: "ringing" })).direction, "incoming");
  assert.equal((await remote.next({ type: "call", state: "ringing" })).direction, "outgoing");
  // Signals are dropped before the call is answered
  remote.send({ type: "signal", data: { early: true } });
  blimp.send({ type: "accept" });
  const r = await remote.next({ type: "call", state: "in_call" });
  const b = await blimp.next({ type: "call", state: "in_call" });
  assert.equal(r.offerer, true, "caller sends the offer");
  assert.equal(b.offerer, false);
  await blimp.next({ type: "presence", blimp: "in_call", remote: "in_call" });
  remote.send({ type: "signal", data: { description: { type: "offer", sdp: "x" } } });
  const sig = await blimp.next({ type: "signal" });
  assert.equal(sig.data.description.type, "offer");
  assert.ok(!blimp.messages.some((m) => m.type === "signal" && m.data.early));
  blimp.send({ type: "signal", data: { candidate: { candidate: "c" } } });
  assert.equal((await remote.next({ type: "signal" })).data.candidate.candidate, "c");
  blimp.send({ type: "hangup" });
  assert.equal((await remote.next({ type: "call", state: "idle" })).reason, "hangup");
  assert.equal((await blimp.next({ type: "call", state: "idle" })).reason, "hangup");
  await remote.next({ type: "presence", blimp: "online" });
  await blimp.close();
  await remote.close();
});

test("blimp calls, remote declines", async () => {
  const { blimp, remote } = await pair();
  blimp.send({ type: "invite" });
  await remote.next({ type: "call", state: "ringing", direction: "incoming" });
  remote.send({ type: "decline" });
  assert.equal((await blimp.next({ type: "call", state: "idle" })).reason, "declined");
  await blimp.close();
  await remote.close();
});

test("caller cancels while ringing", async () => {
  const { blimp, remote } = await pair();
  blimp.send({ type: "invite" });
  await remote.next({ type: "call", state: "ringing" });
  blimp.send({ type: "hangup" });
  assert.equal((await remote.next({ type: "call", state: "idle" })).reason, "cancelled");
  await blimp.close();
  await remote.close();
});

test("ring times out with no_answer (RING_SECONDS=1)", async () => {
  const { blimp, remote } = await pair();
  remote.send({ type: "invite" });
  await blimp.next({ type: "call", state: "ringing" });
  assert.equal((await blimp.next({ type: "call", state: "idle" }, 2500)).reason, "no_answer");
  assert.equal((await remote.next({ type: "call", state: "idle" })).reason, "no_answer");
  await blimp.close();
  await remote.close();
});

test("calls at the same time connect", async () => {
  const { blimp, remote } = await pair();
  remote.send({ type: "invite" });
  await blimp.next({ type: "call", state: "ringing" });
  blimp.send({ type: "invite" });
  assert.equal((await remote.next({ type: "call", state: "in_call" })).offerer, true);
  await blimp.close();
  await remote.close();
});

test("calling an offline peer or a busy line fails", async () => {
  const remote = new Peer("role=remote");
  await remote.next({ type: "welcome" });
  remote.send({ type: "invite" });
  assert.equal((await remote.next({ type: "error" })).error, "peer_offline");
  await remote.close();

  const p = await pair();
  p.remote.send({ type: "invite" });
  await p.blimp.next({ type: "call", state: "ringing" });
  p.remote.send({ type: "invite" });
  assert.equal((await p.remote.next({ type: "error" })).error, "busy");
  await p.blimp.close();
  await p.remote.close();
});

test("peer leaving mid-call ends it; a reconnecting blimp replaces the old one", async () => {
  const { blimp, remote } = await pair();
  remote.send({ type: "invite" });
  await blimp.next({ type: "call", state: "ringing" });
  blimp.send({ type: "accept" });
  await remote.next({ type: "call", state: "in_call" });
  const blimp2 = new Peer(`role=blimp&token=${TOKEN}`);
  assert.equal(await blimp.closed, 4002);
  assert.equal((await remote.next({ type: "call", state: "idle" })).reason, "peer_left");
  await remote.next({ type: "presence", blimp: "online" });
  await remote.close();
  await blimp2.next({ type: "presence", remote: "offline" });
  await blimp2.close();
});

// ---- remote screen control ----

async function screenPair() {
  const agent = new Peer("role=screen");
  await agent.next({ type: "welcome", role: "screen" });
  const viewer = new Peer(`role=viewer&password=${PASSWORD}`);
  await viewer.next({ type: "welcome", role: "viewer" });
  await viewer.next({ type: "screen_presence", agent: "online" });
  agent.drain();
  viewer.drain();
  return { agent, viewer };
}

test("screen: a wrong viewer password is rejected", async () => {
  const viewer = new Peer("role=viewer&password=nope");
  assert.equal((await viewer.next({ type: "error" })).error, "unauthorized");
  assert.equal(await viewer.closed, 4001);
});

test("screen: a viewer sees the agent come online with its device info", async () => {
  const viewer = new Peer(`role=viewer&password=${PASSWORD}`);
  const w = await viewer.next({ type: "welcome" });
  assert.ok(Array.isArray(w.iceServers));
  assert.equal((await viewer.next({ type: "screen_presence" })).agent, "offline");
  const agent = new Peer("role=screen");
  await viewer.next({ type: "screen_presence", agent: "online" });
  agent.send({ type: "info", device: { model: "Test", android: "13", width: 1920, height: 1080 } });
  const p = await viewer.next((m) => m.type === "screen_presence" && m.device);
  assert.equal(p.device.android, "13");
  await agent.close();
  await viewer.next({ type: "screen_presence", agent: "offline" });
  await viewer.close();
});

test("screen: the first device holds the slot; another is refused until it leaves", async () => {
  const first = new Peer("role=screen");
  await first.next({ type: "welcome" });
  const second = new Peer("role=screen");
  assert.equal((await second.next({ type: "error" })).error, "agent_connected");
  assert.equal(await second.closed, 4009);
  await first.close();
  const third = new Peer("role=screen");
  await third.next({ type: "welcome" });
  await third.close();
});

test("screen: viewer starts, agent offers, signals relay both ways, viewer stops", async () => {
  const { agent, viewer } = await screenPair();
  viewer.send({ type: "signal", data: { early: true } }); // no session yet: dropped
  viewer.send({ type: "screen_start" });
  assert.equal((await viewer.next({ type: "screen" })).state, "starting");
  await agent.next({ type: "screen_start" });
  agent.send({ type: "signal", data: { description: { type: "offer", sdp: "x" } } });
  assert.equal((await viewer.next({ type: "signal" })).data.description.type, "offer");
  assert.equal((await viewer.next({ type: "screen" })).state, "streaming");
  await viewer.next({ type: "screen_presence", agent: "streaming" });
  viewer.send({ type: "signal", data: { description: { type: "answer", sdp: "y" } } });
  assert.equal((await agent.next({ type: "signal" })).data.description.type, "answer");
  assert.ok(!agent.messages.some((m) => m.type === "signal" && m.data.early));
  viewer.send({ type: "screen_stop" });
  assert.equal((await agent.next({ type: "screen_stop" })).reason, "stopped");
  assert.equal((await viewer.next({ type: "screen", state: "idle" })).reason, "stopped");
  await viewer.next({ type: "screen_presence", agent: "online" });
  await agent.close();
  await viewer.close();
});

test("screen: a second viewer is refused while one is connected", async () => {
  const { agent, viewer } = await screenPair();
  viewer.send({ type: "screen_start" });
  await agent.next({ type: "screen_start" });
  const second = new Peer(`role=viewer&password=${PASSWORD}`);
  assert.equal((await second.next({ type: "error" })).error, "busy");
  assert.equal(await second.closed, 4009);
  // The first viewer's session is untouched
  assert.ok(!agent.messages.some((m) => m.type === "screen_stop"));
  await viewer.close();
  assert.equal((await agent.next({ type: "screen_stop" })).reason, "viewer_left");
  const third = new Peer(`role=viewer&password=${PASSWORD}`);
  await third.next({ type: "welcome" });
  await third.close();
  await agent.close();
});

test("screen: the agent leaving or failing ends the session", async () => {
  const { agent, viewer } = await screenPair();
  viewer.send({ type: "screen_start" });
  await agent.next({ type: "screen_start" });
  agent.send({ type: "screen_error", error: "no capture permission" });
  assert.match((await viewer.next({ type: "screen", state: "idle" })).reason, /no capture permission/);
  viewer.send({ type: "screen_start" });
  await agent.next({ type: "screen_start" });
  await agent.close();
  assert.equal((await viewer.next({ type: "screen", state: "idle" })).reason, "agent_left");
  await viewer.next({ type: "screen_presence", agent: "offline" });
  await viewer.close();
});

test("screen: calls and screen sessions don't see each other's messages", async () => {
  const { agent, viewer } = await screenPair();
  const { blimp, remote } = await pair();
  remote.send({ type: "invite" });
  await blimp.next({ type: "call", state: "ringing" });
  viewer.send({ type: "screen_start" });
  await agent.next({ type: "screen_start" });
  assert.ok(!viewer.messages.some((m) => m.type === "call" || m.type === "presence"));
  assert.ok(!blimp.messages.some((m) => m.type.startsWith("screen")));
  for (const p of [agent, viewer, blimp, remote]) await p.close();
});

test("screen: five wrong passwords lock the address out", async () => {
  // A successful sign-in clears the count, so this takes five in a row
  for (let i = 0; i < 5; i++) {
    const bad = new Peer("role=viewer&password=wrong");
    assert.equal(await bad.closed, 4001);
  }
  const good = new Peer(`role=viewer&password=${PASSWORD}`);
  assert.equal((await good.next({ type: "error" })).error, "locked");
  assert.equal(await good.closed, 4029);
});

test("static page and module are served; traversal is not", async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const base = `https://127.0.0.1:${PORT}`;
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Call Blimp<\/title>/);
  assert.equal((await fetch(`${base}/call-client.mjs`)).headers.get("content-type"), "text/javascript");
  assert.equal((await fetch(`${base}/..%2Fserver.mjs`)).status, 404);
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.screen.enabled, true);
  const screenPage = await fetch(`${base}/screen`);
  assert.match(await screenPage.text(), /<title>Blimp Screen<\/title>/);
  assert.equal((await fetch(`${base}/screen-client.mjs`)).status, 200);
  const slash = await fetch(`${base}/screen/`, { redirect: "manual" });
  assert.equal(slash.status, 301);
  assert.equal(slash.headers.get("location"), "/screen");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
server.kill();
console.log(failed ? `${failed} failed` : `all ${tests.length} passed`);
process.exit(failed ? 1 : 0);
