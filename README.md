# stream-server

Streaming server for BlimpMate. Today: 1:1 WebRTC video calls between one BlimpMate device and one remote browser user.

- `https://<host>:8443/`: the remote user's page (presence, Call, Accept/Decline, Mute, Camera, Hang up).
- `wss://<host>:8443/ws?role=remote`: signaling for the browser. The first browser is the remote user; later ones wait in line and are promoted when it leaves.
- `wss://<host>:8443/ws?role=blimp&token=<BLIMP_TOKEN>`: signaling for the Blimp. A new Blimp connection replaces the old one.
- `/healthz`: presence and call state as JSON.
- `?as=blimp&token=…` on the page turns it into a Blimp test console.

Media goes peer to peer (or through TURN); the server only relays signaling.

## Run

```
npm install
npm run cert            # self-signed; add the VPS IP: npm run cert -- 203.0.113.7
cp .env.example .env    # set BLIMP_TOKEN
npm start
npm test                # signaling tests + headless Chrome call and screen-control tests
```

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
- The agent sends the offer: one video track (the screen) and an `input` data
  channel. Input never passes through the server.

Protocol (JSON over the WebSocket; details in `screen.mjs`):
- Agent → server: `info {device}`, `signal {data}`, `screen_error {error}`, `ping`
- Server → agent: `welcome {iceServers}`, `screen_start`, `screen_stop {reason}`, `signal {data}`
- Viewer → server: `screen_start`, `screen_stop`, `signal {data}`, `ping`
- Server → viewer: `welcome {iceServers}`, `screen_presence {agent: offline|online|streaming, device}`,
  `screen {state: idle|starting|streaming, reason}`, `signal {data}`,
  `error {error: unauthorized|locked|busy|screen_disabled|agent_offline}`; the agent can get `agent_connected`

Input channel (viewer → agent, each acked with `{t: "ack", id, ok, error?}`):
`{t: "gesture", points: [[x, y, ms], ...]}` (x, y are fractions of the screen),
`{t: "key", key: back|home|recents|notifications|enter|backspace|blimp_app}`,
`{t: "text", text}`, `{t: "quality", preset: low|medium|high}`.
