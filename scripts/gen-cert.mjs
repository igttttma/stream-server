// Certificates signed by your own CA. The BlimpMate apps trust the CA, so a new
// server only needs a new certificate, never an app rebuild.
//
//   npm run cert                              this machine: localhost, 127.0.0.1, LAN IPs -> certs/
//   npm run cert -- 203.0.113.7 --out certs/vps   a server: localhost, 127.0.0.1 and the given hosts/IPs
//
// The first run creates the CA in certs/:
//   ca.pem      public; bundle it with the apps (BlimpMate_Agent_Clean/src/certs/stream-server-ca.pem)
//   ca-key.pem  private; keep it on this machine, never copy it to a server
// Copy <out>/cert.pem and <out>/key.pem to the server's certs/.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const caDir = join(root, "certs");
const caCert = join(caDir, "ca.pem");
const caKey = join(caDir, "ca-key.pem");

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const outDir = outAt >= 0 ? resolve(args[outAt + 1]) : caDir;
const hosts = args.filter((a, i) => a !== "--out" && i !== outAt + 1);
mkdirSync(caDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const openssl = (...a) => execFileSync("openssl", a, { stdio: ["ignore", "ignore", "inherit"] });

if (!existsSync(caCert) || !existsSync(caKey)) {
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
    "-keyout", caKey, "-out", caCert, "-subj", "/CN=BlimpMate stream server CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  console.log(`New CA: ${caCert} (bundle with the apps) and ${caKey} (keep private)`);
}

// No hosts given: this machine, reachable on its LAN addresses too
const names = new Set(["localhost", "127.0.0.1", ...hosts]);
if (!hosts.length) {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) if (a.family === "IPv4" && !a.internal) names.add(a.address);
  }
}
const san = [...names].map((n) => (isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(",");

const csr = join(outDir, "req.csr");
const ext = join(outDir, "req.ext");
writeFileSync(ext, [
  "basicConstraints=critical,CA:FALSE",
  "keyUsage=critical,digitalSignature,keyEncipherment",
  "extendedKeyUsage=serverAuth",
  `subjectAltName=${san}`,
].join("\n"));
openssl("req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", join(outDir, "key.pem"),
  "-out", csr, "-subj", `/CN=${hosts[0] || "localhost"}`);
// 825 days: the longest validity Apple platforms accept for a server certificate
openssl("x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
  "-days", "825", "-sha256", "-extfile", ext, "-out", join(outDir, "cert.pem"));
rmSync(csr);
rmSync(ext);
console.log(`${join(outDir, "cert.pem")} signed by the CA for ${san}`);
