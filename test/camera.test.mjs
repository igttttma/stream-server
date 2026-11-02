// Live camera view: a fake Blimp camera and pages against a real server.
// Run: node test/camera.test.mjs   (starts its own server on a spare port)
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18444;

const server = spawn(process.execPath, ["server.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", CAMERA_STOP_GRACE_MS: "600" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("stream server on") && resolve());
  server.on("exit", (code) => reject(new Error(`server exited ${code}`)));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function open(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws?${query}`, { rejectUnauthorized: false });
    ws.messages = [];
    ws.packets = [];
    ws.on("message", (d, binary) => (binary ? ws.packets.push(Buffer.from(d)) : ws.messages.push(JSON.parse(d))));
    ws.closed = new Promise((r) => ws.on("close", (code) => r(code)));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
const packet = (flags, size) => {
  const b = Buffer.alloc(9 + size);
  b[0] = flags;
  return b;
};
const page = () => open("role=camera_viewer");
const last = (ws) => ws.messages.filter((m) => m.type === "camera").at(-1);
const count = (ws, type) => ws.messages.filter((m) => m.type === type).length;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`not ok - ${name}\n  ${err.stack}`);
  }
}

await test("the Blimp side needs the token (pages need nothing)", async () => {
  const fake = new WebSocket(`wss://127.0.0.1:${PORT}/ws?role=camera&token=nope`, { rejectUnauthorized: false });
  assert.equal(await new Promise((r) => fake.on("close", r)), 4001);
});

const cam = await open("role=camera&token=blimpmate");
const p1 = await page();

await test("the first page starts the camera and sees it", async () => {
  await sleep(150);
  assert.equal(count(cam, "camera_start"), 1);
  assert.equal(last(p1).agent, "online");
});

await test("video reaches the page", async () => {
  cam.send(JSON.stringify({ type: "camera_state", state: "streaming", width: 1440, height: 1080, rotation: 0, kbps: 2500 }));
  cam.send(packet(1, 20));
  cam.send(packet(2, 1000));
  cam.send(packet(0, 300));
  await sleep(150);
  assert.equal(p1.packets.length, 3);
  assert.equal(last(p1).state, "streaming");
});

let p2;
await test("a late page gets the config, then waits for a keyframe", async () => {
  p2 = await page();
  await sleep(150);
  assert.equal(p2.packets.length, 1);
  assert.equal(p2.packets[0][0], 1);
  assert.ok(count(cam, "keyframe") >= 1);
  cam.send(packet(0, 300));
  await sleep(100);
  assert.equal(p2.packets.length, 1);
  cam.send(packet(2, 1000));
  cam.send(packet(0, 300));
  await sleep(150);
  assert.equal(p2.packets.length, 3);
});

await test("a page that stops acking falls behind alone and the camera hears of it", async () => {
  // p1 acks everything; p2 acks nothing past what it has now
  const acked = p2.packets.reduce((n, p) => n + p.length, 0);
  p2.send(JSON.stringify({ type: "ack", bytes: acked }));
  const before1 = p1.packets.length;
  for (let i = 0; i < 40; i++) {
    cam.send(packet(0, 8 * 1024));
    p1.send(JSON.stringify({ type: "ack", bytes: p1.packets.reduce((n, p) => n + p.length, 0) }));
    await sleep(10);
  }
  await sleep(150);
  assert.equal(p1.packets.length - before1, 40);
  assert.ok(p2.packets.length < 3 + 40, `slow page got ${p2.packets.length - 3} of 40`);
  assert.ok(count(cam, "congestion") >= 1);
});

await test("pauses reach the pages", async () => {
  cam.send(JSON.stringify({ type: "camera_state", state: "paused", reason: "photo" }));
  await sleep(100);
  assert.deepEqual([last(p1).state, last(p1).reason], ["paused", "photo"]);
});

await test("the camera stops a while after nobody watches", async () => {
  p1.send(JSON.stringify({ type: "watch", on: false }));
  p2.close();
  await sleep(200);
  assert.equal(count(cam, "camera_stop"), 0);
  await sleep(700);
  assert.equal(count(cam, "camera_stop"), 1);
  p1.send(JSON.stringify({ type: "watch", on: true }));
  await sleep(150);
  assert.equal(count(cam, "camera_start"), 2);
});

await test("a reconnecting Blimp replaces the old connection and is started again", async () => {
  const cam2 = await open("role=camera&token=blimpmate");
  assert.equal(await cam.closed, 4002);
  await sleep(150);
  assert.equal(count(cam2, "camera_start"), 1);
  cam2.close();
  await sleep(150);
  assert.equal(last(p1).agent, "offline");
});

p1.close();
server.kill();
if (failed) process.exitCode = 1;
