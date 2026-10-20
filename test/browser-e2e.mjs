// Real WebRTC calls between two headless Chrome tabs (fake camera/mic): the
// remote page and the Blimp test console. Then remote screen control: the
// /screen page against a fake screen agent in another tab (a canvas encoded
// to H.264 as the screen; it records the input it gets). Run: node test/browser-e2e.mjs
// CHROME=path overrides the browser.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18444;
const CDP_PORT = 9555;
const TOKEN = "blimpmate";
const PASSWORD = "e2e-pass";
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", STUN_URLS: "",
    SCREEN_PASSWORD: PASSWORD },
  stdio: ["ignore", "pipe", "inherit"],
});
if (process.env.VERBOSE) server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
await new Promise((r) => server.stdout.on("data", (d) => String(d).includes("stream server on") && r()));

const profile = mkdtempSync(join(tmpdir(), "vc-e2e-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
  "--ignore-certificate-errors", "--autoplay-policy=no-user-gesture-required", "about:blank",
], { stdio: "ignore" });

async function cdpJson(path, method = "GET") {
  for (let i = 0; i < 50; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}${path}`, { method })).json(); } catch { await sleep(200); }
  }
  throw new Error("Chrome DevTools not reachable");
}

class Tab {
  static async open(url, { phone = false } = {}) {
    const target = await cdpJson(`/json/new?${encodeURIComponent(phone ? "about:blank" : url)}`, "PUT");
    const tab = new Tab(target.webSocketDebuggerUrl);
    await new Promise((r) => tab.ws.on("open", r));
    if (phone) {
      // Touch screen → (pointer: coarse): the page treats it as a phone
      await tab.cmd("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await tab.cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      await tab.cmd("Page.navigate", { url });
    }
    return tab;
  }
  cmd(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
  }
  async eval(expression) {
    const reply = await this.cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || "eval failed");
    return reply.result?.result?.value;
  }
  async until(expression, label, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
      last = await this.eval(expression).catch((e) => e.message);
      if (last === true) return;
      await sleep(150);
    }
    throw new Error(`timed out: ${label} (last: ${JSON.stringify(last)})`);
  }
  async click(id) {
    // Waits for the element: the page re-renders its panel on every state change
    await this.until(`!!document.getElementById(${JSON.stringify(id)})`, `#${id} present`);
    return this.eval(`document.getElementById(${JSON.stringify(id)}).click(), true`);
  }
}

// A screen agent in a page, speaking the Android agent's protocol: a 1280x720
// canvas (a moving bar) encoded to H.264 Annex B with WebCodecs and sent as
// binary packets (SPS/PPS as a config packet before each keyframe). It records
// the presets and input it gets and acks each input like the Android agent.
const FAKE_AGENT = (url) => `(() => {
  window.agentInputs = [];
  window.agentStops = [];
  window.agentPresets = [];
  const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
  const g = canvas.getContext("2d");
  let t = 0, streaming = false, wantKey = false, ts = 0;
  const ws = new WebSocket(${JSON.stringify(url)});
  ws.binaryType = "arraybuffer";
  const send = (m) => ws.send(JSON.stringify(m));
  const packet = (flags, bytes, timestamp) => {
    const p = new Uint8Array(9 + bytes.length);
    p[0] = flags;
    new DataView(p.buffer).setBigInt64(1, BigInt(timestamp));
    p.set(bytes, 9);
    ws.send(p);
  };
  // The SPS (7) and PPS (8) NAL units of an Annex B keyframe
  const parameterSets = (b) => {
    const starts = [];
    for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) starts.push(i);
    const out = [];
    starts.forEach((s, k) => {
      const type = b[s + 3] & 0x1f;
      const end = k + 1 < starts.length ? starts[k + 1] - (b[starts[k + 1] - 1] === 0 ? 1 : 0) : b.length;
      if (type === 7 || type === 8) out.push(0, 0, 0, 1, ...b.subarray(s + 3, end));
    });
    return new Uint8Array(out);
  };
  const encoder = new VideoEncoder({
    output: (chunk) => {
      if (!streaming) return;
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      if (chunk.type === "key") {
        packet(1, parameterSets(bytes), chunk.timestamp);
        packet(2, bytes, chunk.timestamp);
      } else {
        packet(0, bytes, chunk.timestamp);
      }
    },
    error: (e) => { window.agentError = e.message; },
  });
  encoder.configure({ codec: "avc1.42001f", width: 1280, height: 720, bitrate: 2000000, framerate: 30,
    latencyMode: "realtime", avc: { format: "annexb" } });
  setInterval(() => {
    g.fillStyle = "#123"; g.fillRect(0, 0, 1280, 720); g.fillStyle = "#fa0"; g.fillRect((t += 8) % 1280, 300, 80, 120);
    if (!streaming || encoder.encodeQueueSize > 2) return;
    const frame = new VideoFrame(canvas, { timestamp: (ts += 33333) });
    encoder.encode(frame, { keyFrame: wantKey });
    wantKey = false;
    frame.close();
  }, 33);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "welcome") send({ type: "info", device: { model: "Fake", android: "13", width: 1280, height: 720, input: true } });
    if (m.type === "screen_start") { window.agentPresets.push(m.preset); streaming = true; wantKey = true; }
    if (m.type === "screen_stop") { window.agentStops.push(m.reason); streaming = false; }
    if (m.type === "keyframe") wantKey = true;
    if (m.type === "input") {
      window.agentInputs.push(m.data);
      if (m.data.t === "keyframe") wantKey = true;
      else send({ type: "viewer", data: { t: "ack", id: m.data.id, ok: true } });
    }
  };
  return true;
})()`;

// Bytes received on each inbound media kind, and the decoded video size
const STATS = `(async () => {
  const pc = window.callClient.pc; if (!pc) return null;
  const out = { audio: 0, video: 0 };
  (await pc.getStats()).forEach((s) => { if (s.type === "inbound-rtp") out[s.kind] += s.bytesReceived; });
  const v = document.getElementById("remoteVideo");
  out.size = v.videoWidth + "x" + v.videoHeight;
  return out;
})()`;

async function assertMediaFlows(tab, name) {
  await tab.until(`window.callClient.pc?.connectionState === "connected"`, `${name} connected`);
  const a = await tab.eval(STATS);
  await sleep(1500);
  const b = await tab.eval(STATS);
  assert.ok(b.audio > a.audio, `${name} receives audio (${a.audio} -> ${b.audio})`);
  assert.ok(b.video > a.video, `${name} receives video (${a.video} -> ${b.video})`);
  // The fake camera is 640x480 (4:3); the page crops it to 16:9 landscape.
  // (Resolution ramps up with the bandwidth estimate, so check the shape.)
  const [w, h] = b.size.split("x").map(Number);
  assert.ok(w > 0 && Math.abs(w / h - 16 / 9) < 0.02, `${name} gets 16:9 landscape video (got ${b.size})`);
  console.log(`     ${name}: audio +${b.audio - a.audio} B, video +${b.video - a.video} B in 1.5s, ${b.size}`);
}

const base = `https://127.0.0.1:${PORT}/`;
let failed = 0;
const step = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
};

try {
  await cdpJson("/json/version");
  const blimp = await Tab.open(`${base}?as=blimp&token=${TOKEN}`);
  const remote = await Tab.open(base);

  await step("remote page shows the blimp online", async () => {
    await remote.until(`document.getElementById("presenceText").textContent === "Blimp online"`, "presence");
    await remote.until(`!document.getElementById("callBtn").disabled`, "call button enabled");
  });

  await step("remote calls, blimp answers, media flows both ways", async () => {
    await remote.click("callBtn");
    await blimp.until(`!!document.getElementById("acceptBtn")`, "blimp rings");
    await remote.until(`!!document.getElementById("cancelBtn")`, "remote shows calling");
    await blimp.click("acceptBtn");
    await assertMediaFlows(remote, "remote");
    await assertMediaFlows(blimp, "blimp");
    await remote.until(`document.body.classList.contains("in-call")`, "remote in call view");
  });

  await step("mute stops the outgoing audio track", async () => {
    await remote.click("micBtn");
    assert.equal(await remote.eval(`window.callClient.localStream.getAudioTracks()[0].enabled`), false);
    await remote.click("micBtn");
    assert.equal(await remote.eval(`window.callClient.localStream.getAudioTracks()[0].enabled`), true);
  });

  await step("blimp hangs up: both return to idle and release the camera", async () => {
    await blimp.click("hangupBtn");
    await remote.until(`window.callClient.call.state === "idle" && !window.callClient.localStream && !window.callClient.pc`, "remote idle");
    await blimp.until(`window.callClient.call.state === "idle" && !window.callClient.localStream`, "blimp idle");
    await remote.until(`document.getElementById("toast").textContent === "Call ended"`, "remote toast");
  });

  await step("blimp calls, remote declines", async () => {
    await blimp.until(`!document.getElementById("callBtn")?.disabled`, "blimp can call");
    await blimp.click("callBtn");
    await remote.until(`!!document.getElementById("declineBtn")`, "remote rings");
    await remote.click("declineBtn");
    await blimp.until(`document.getElementById("toast").textContent === "Remote user declined the call"`, "blimp told");
    await blimp.until(`!window.callClient.localStream`, "blimp released media");
  });

  await step("blimp calls, remote answers (blimp is the offerer)", async () => {
    await blimp.click("callBtn");
    await remote.until(`!!document.getElementById("acceptBtn")`, "remote rings");
    await remote.click("acceptBtn");
    await assertMediaFlows(blimp, "blimp");
    await assertMediaFlows(remote, "remote");
  });

  await step("remote closing the page ends the call; blimp shows remote offline", async () => {
    await remote.eval(`window.callClient.close(), true`);
    await blimp.until(`window.callClient.call.state === "idle" && !window.callClient.pc`, "blimp idle");
    await blimp.until(`window.callClient.presence.remote === "offline"`, "remote offline");
  });

  await step("phone remote: video is cropped to 16:9 landscape; rotate hint in portrait", async () => {
    await remote.eval(`window.callClient.close(), true`);
    const phone = await Tab.open(base, { phone: true });
    await phone.until(`matchMedia("(pointer: coarse)").matches && !document.getElementById("callBtn")?.disabled`, "phone ready");
    await phone.click("callBtn");
    await blimp.until(`!!document.getElementById("acceptBtn")`, "blimp rings");
    await blimp.click("acceptBtn");
    await assertMediaFlows(blimp, "blimp (from phone)");
    const sent = await phone.eval(`JSON.stringify(window.callClient.localStream.getVideoTracks()[0].getSettings())`);
    const { width, height } = JSON.parse(sent);
    assert.equal(`${width}x${height}`, "960x540", `phone sends the cropped canvas track (${sent})`);
    assert.equal(await phone.eval(`getComputedStyle(document.getElementById("rotateHint")).display`), "flex");
    await phone.click("hangupBtn");
    await phone.until(`!window.callClient.localStream`, "phone released camera");
    await phone.eval(`window.callClient.close(), true`);
    await blimp.until(`window.callClient.presence.remote === "offline"`, "phone gone");
  });

  await step("a second browser waits while the first is connected", async () => {
    await remote.eval(`window.callClient.connect(), true`);
    await remote.until(`window.callClient.presence.remote === "online"`, "first back");
    const third = await Tab.open(base);
    await third.until(`document.getElementById("panel").textContent.includes("Line busy")`, "third waits");
    await remote.eval(`window.callClient.close(), true`);
    await third.until(`document.getElementById("presenceText").textContent === "Blimp online"`, "third promoted");
  });

  // ---- remote screen control ----
  for (const t of [blimp, remote]) await t.eval(`window.callClient.close(), true`);
  // Any https page of the server (WebCodecs needs a secure context); this one runs no scripts
  const agent = await Tab.open(`${base}screen-client.mjs`);
  await agent.eval(FAKE_AGENT(`wss://127.0.0.1:${PORT}/ws?role=screen`));
  const viewer = await Tab.open(`${base}screen`);
  await viewer.cmd("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });

  await step("screen: a wrong password is refused; the right one shows the Blimp online", async () => {
    await viewer.until(`!!document.getElementById("pw")`, "sign-in form");
    await viewer.eval(`document.getElementById("pw").value = "nope", document.getElementById("signin").requestSubmit(), true`);
    await viewer.until(`document.getElementById("panel").textContent.includes("Wrong password")`, "wrong password shown");
    await viewer.eval(`document.getElementById("pw").value = ${JSON.stringify(PASSWORD)}, document.getElementById("signin").requestSubmit(), true`);
    await viewer.until(`document.getElementById("presenceText").textContent.startsWith("Blimp online (Fake, Android 13)")`, "presence with device");
  });

  await step("screen: watch shows the agent's screen", async () => {
    await viewer.click("watchBtn");
    await viewer.until(`document.body.classList.contains("streaming")`, "streaming view");
    // Decoded with WebCodecs onto the canvas
    await viewer.until(`window.screenViewer.width === 1280 && window.screenViewer.framesDecoded > 5`, "video arrives", 15000);
    // The quality preset goes with the start request
    assert.deepEqual(await agent.eval(`window.agentPresets`), ["medium"]);
  });

  // The picture's box inside the stage (object-fit: contain), in page pixels
  const box = async () => JSON.parse(await viewer.eval(`(() => {
    const st = document.getElementById("stage").getBoundingClientRect(), v = window.screenViewer;
    const s = Math.min(st.width / v.width, st.height / v.height), w = v.width * s, h = v.height * s;
    return JSON.stringify({ x: st.left + (st.width - w) / 2, y: st.top + (st.height - h) / 2, w, h });
  })()`));
  const mouse = (type, x, y, extra = {}) => viewer.cmd("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });
  const lastInput = (t) => agent.eval(`JSON.stringify(window.agentInputs.filter((m) => m.t === ${JSON.stringify(t)}).at(-1) || null)`).then(JSON.parse);

  await step("screen: a click is a tap at the right spot; the agent acks it", async () => {
    const b = await box();
    await mouse("mousePressed", b.x + b.w * 0.25, b.y + b.h * 0.5);
    await mouse("mouseReleased", b.x + b.w * 0.25, b.y + b.h * 0.5);
    await agent.until(`window.agentInputs.some((m) => m.t === "gesture")`, "gesture received");
    const g = await lastInput("gesture");
    const [x, y] = g.points[0];
    assert.ok(Math.abs(x - 0.25) < 0.01 && Math.abs(y - 0.5) < 0.01, `tap at (0.25, 0.5), got (${x}, ${y})`);
    assert.ok(g.points.at(-1)[2] < 300, "short press");
    await viewer.until(`document.getElementById("stats").textContent.includes("input ")`, "input latency shown", 5000);
  });

  await step("screen: a drag is one gesture with its path and timing", async () => {
    const b = await box();
    await mouse("mousePressed", b.x + b.w * 0.2, b.y + b.h * 0.8);
    for (let i = 1; i <= 10; i++) {
      await sleep(30);
      await mouse("mouseMoved", b.x + b.w * (0.2 + 0.05 * i), b.y + b.h * 0.8, { buttons: 1 });
    }
    await mouse("mouseReleased", b.x + b.w * 0.7, b.y + b.h * 0.8);
    await agent.until(`window.agentInputs.filter((m) => m.t === "gesture").length >= 2`, "drag received");
    const g = await lastInput("gesture");
    assert.ok(g.points.length >= 8, `path has ${g.points.length} points`);
    assert.ok(Math.abs(g.points.at(-1)[0] - 0.7) < 0.01, "ends at x 0.7");
    assert.ok(g.points.at(-1)[2] >= 250, `takes its real time (${g.points.at(-1)[2]} ms)`);
  });

  await step("screen: right-click is Back; typing sends text; Backspace and buttons send keys", async () => {
    const b = await box();
    await mouse("mousePressed", b.x + 10, b.y + 10, { button: "right" });
    await mouse("mouseReleased", b.x + 10, b.y + 10, { button: "right" });
    await agent.until(`window.agentInputs.some((m) => m.t === "key" && m.key === "back")`, "back key");
    for (const ch of "hi!") await viewer.cmd("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
    await viewer.cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await agent.until(`window.agentInputs.some((m) => m.t === "key" && m.key === "backspace")`, "backspace");
    const texts = await agent.eval(`window.agentInputs.filter((m) => m.t === "text").map((m) => m.text).join("")`);
    assert.equal(texts, "hi!", "typed text arrives before the backspace");
    await viewer.eval(`document.querySelector('[data-key="home"]').click(), true`);
    await agent.until(`window.agentInputs.some((m) => m.t === "key" && m.key === "home")`, "home button");
  });

  await step("screen: a second viewer is refused; the first keeps watching", async () => {
    const other = await Tab.open(`${base}screen`);
    await other.until(`!!document.getElementById("pw")`, "other sign-in");
    await other.eval(`document.getElementById("pw").value = ${JSON.stringify(PASSWORD)}, document.getElementById("signin").requestSubmit(), true`);
    await other.until(`document.getElementById("panel").textContent.includes("Someone else is connected")`, "second viewer refused");
    assert.equal(await viewer.eval(`window.screenViewer.session.state`), "streaming");
    await viewer.click("stopBtn");
    await agent.until(`window.agentStops.includes("stopped")`, "agent told to stop");
    await viewer.until(`!document.body.classList.contains("streaming") && window.screenViewer.width === 0`, "viewer idle");
  });
} finally {
  // Close Chrome through DevTools: killing the process leaves its children running on Windows
  try {
    const { webSocketDebuggerUrl } = await cdpJson("/json/version");
    const browser = new WebSocket(webSocketDebuggerUrl);
    await new Promise((r) => browser.on("open", r));
    browser.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await new Promise((r) => { chrome.on("exit", r); setTimeout(r, 5000); });
  } catch {
    chrome.kill();
  }
  server.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
