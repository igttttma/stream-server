# stream-server

Streaming server for BlimpMate: 1:1 WebRTC video calls between one BlimpMate device and one remote browser user, and remote control of the Blimp's Android screen.

- `https://<host>:8443/`: the remote user's page (presence, Call, Accept/Decline, Mute, Camera, Hang up).
- `wss://<host>:8443/ws?role=remote`: signaling for the browser. The first browser is the remote user; later ones wait in line and are promoted when it leaves.
- `wss://<host>:8443/ws?role=blimp&token=blimpmate`: signaling for the Blimp (the password is fixed in the server and the Blimp app). A new Blimp connection replaces the old one.
- `/healthz`: presence and call state as JSON.
- `?as=blimp&token=…` on the page turns it into a Blimp test console.

Call media goes peer to peer (or through TURN); the server only relays signaling.
Remote screen control's video goes through the server (see below).

## Run

```
npm install
npm run cert            # local certificate, signed by your CA (made on the first run); VPS: see below
cp .env.example .env    # set SCREEN_PASSWORD
npm start
npm test                # signaling tests + headless Chrome call and screen-control tests
```

## Deploy to a VPS

A Let's Encrypt certificate for the server's IP address is trusted by every
browser and app: no warning, no app rebuild, nothing to carry between servers.
It lasts ~6 days and renews itself.

1. Open TCP 80 (certificate checks) and 8443 in the VPS firewall / security group.
2. Copy the server over (with `node_modules`, in case the VPS can't reach GitHub or npm) and your `.env`:
   ```
   git archive -o stream-server.tar HEAD && tar -rf stream-server.tar node_modules
   scp stream-server.tar .env root@<IP>:/tmp/
   ssh root@<IP> 'mkdir -p /opt/stream-server && tar -xf /tmp/stream-server.tar -C /opt/stream-server && mv /tmp/.env /opt/stream-server/'
   ```
3. `ssh root@<IP> 'bash /opt/stream-server/scripts/setup-vps.sh <IP>'`: Node.js, the
   certificate, renewal every 6 hours, and the `stream-server` systemd service.

Then point the Blimp's apps at `wss://<IP>:8443` and open `https://<IP>:8443/screen`.

## Local certificates (testing without a public IP)

`npm run cert` signs certificates with your own CA. The BlimpMate apps also trust
that CA (`BlimpMate_Agent_Clean/src/certs/stream-server-ca.pem`), so local and LAN
servers work too; browsers warn unless you import `certs/ca.pem`.

- The first run creates `certs/ca.pem` (public) and `certs/ca-key.pem` (private:
  never copy it to a server).
- Another machine: `npm run cert -- 192.168.1.20 --out certs/lan`, then copy
  `certs/lan/cert.pem` and `key.pem` to that server's `certs/`.

## Protocol (JSON over the WebSocket)

Client → server: `invite`, `accept`, `decline`, `hangup` (cancels while ringing), `signal {data}`, `ping`.

Server → client:
- `welcome {role, iceServers, ringSeconds}`
- `waiting {position}`
- `presence {blimp, remote}` (each `offline | online | in_call`)
- `call {state: idle|ringing|in_call, direction, offerer, reason}`; `reason` on idle is one of `declined | cancelled | no_answer | hangup | peer_left`
- `signal {data}`
- `error {error: unauthorized|peer_offline|busy}`

Media is captured only after the call is answered; the caller then sends the offer.
`public/call-client.mjs` implements a client and is meant to be reused by the BlimpMate app.

## Remote screen control

`https://<host>:8443/screen`: watch and control the Blimp's Android screen (like
scrcpy). The agent is the BlimpMate Remote app
(`BlimpMate_Agent_Clean/src/hosts/android/remote`, see its README for the device setup).

- Set `SCREEN_PASSWORD` in `.env` (viewers sign in with it). Unset = screen control off.
- One device and one viewer at a time. Whoever connects first holds the slot; another
  device or viewer is refused (close code 4009) until it leaves. A dead connection is
  dropped by the heartbeat within 30 s.
- `wss://<host>:8443/ws?role=screen`: the agent (no token).
- `wss://<host>:8443/ws?role=viewer&password=<SCREEN_PASSWORD>`: the viewer. Five wrong
  passwords in a row lock that address out for a minute.
- The agent encodes the screen with the device's hardware H.264 encoder (scrcpy's
  approach: the screen renders straight into the encoder) and sends the packets
  over its WebSocket; the server passes them to the viewer, which decodes them
  with WebCodecs onto a canvas. Input goes back the same way. A viewer that falls
  behind gets only keyframes until it catches up, and the agent is asked for one.
- Direct path: meanwhile the agent offers a WebRTC data channel to the viewer
  (this server relays the signals; STUN from `STUN_URLS`). When it opens, the
  packets go there from the next keyframe (in fragments: byte 0 is 1 on a
  packet's last one), and back through the server if it closes. The viewer's
  stats line shows `direct` or `relay`.

Protocol (details in `screen.mjs`). JSON:
- Agent → server: `info {device}`, `viewer {data}` (acks, stats), `signal {data}`, `screen_error {error}`, `ping`
- Server → agent: `welcome {iceServers}`, `screen_start {preset}`, `screen_stop {reason}`, `input {data}`,
  `keyframe`, `signal {data}`
- Viewer → server: `screen_start {preset}`, `screen_stop`, `input {data}`, `signal {data}`, `ping`
- Server → viewer: `welcome {iceServers}`, `screen_presence {agent: offline|online|streaming, device}`,
  `screen {state: idle|starting|streaming, reason}`, `agent {data}`, `signal {data}`,
  `error {error: unauthorized|locked|busy|screen_disabled|agent_offline}`; the agent can get `agent_connected`

Binary (agent → server → viewer): one video packet per message. Byte 0 is flags
(1 = codec config: SPS/PPS, 2 = keyframe), bytes 1-8 the presentation time in µs
(big endian), then H.264 Annex B data.

Input (viewer → agent in `input {data}`, each acked with `{t: "ack", id, ok, error?}`):
`{t: "gesture", points: [[x, y, ms], ...]}` (x, y are fractions of the screen),
`{t: "key", key: back|home|recents|notifications|enter|backspace|blimp_app}`,
`{t: "text", text}`, `{t: "quality", preset: low|medium|high}`, `{t: "keyframe"}` (not acked).
