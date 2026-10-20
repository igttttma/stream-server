// Self-signed certificate for local testing. Covers localhost, 127.0.0.1, this
// machine's LAN IPs, and any extra hosts/IPs given as arguments (e.g. the VPS IP):
//   npm run cert -- 203.0.113.7
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { X509Certificate, createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "certs");
mkdirSync(dir, { recursive: true });

const names = new Set(["localhost", "127.0.0.1", ...process.argv.slice(2)]);
for (const addrs of Object.values(networkInterfaces())) {
  for (const a of addrs || []) if (a.family === "IPv4" && !a.internal) names.add(a.address);
}
const san = [...names].map((n) => (isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(",");

execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
  "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  "-subj", "/CN=BlimpMate video chat", "-addext", `subjectAltName=${san}`,
], { stdio: "inherit" });
const der = new X509Certificate(readFileSync(join(dir, "cert.pem"))).raw;
console.log(`certs/cert.pem written for ${san}`);
// Clients pin this certificate: Android bundles cert.pem (res/raw/stream_server_cert.pem);
// Electron takes BM_VIDEO_CHAT_CERT_FINGERPRINT.
console.log(`BM_VIDEO_CHAT_CERT_FINGERPRINT=sha256/${createHash("sha256").update(der).digest("base64")}`);
