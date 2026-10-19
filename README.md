# Gridline — real-time shared territory

A complete multiplayer app: 900 tiles, one shared board, and server-authoritative captures. Open it in two browsers and see each move appear immediately.

## Run locally

Requires **Node.js 24 or newer** (uses the built-in SQLite API).

```sh
npm ci
npm start
```

Open **http://127.0.0.1:3000**. To play as a second explorer, use another browser or a private window. Tabs in the same browser share an identity and cooldown. Change the port with the `PORT` environment variable.

```sh
npm test
```

No build step, external database, account, or API key is needed. The server creates `data/grid.sqlite` automatically. Keep the database and its WAL files on a persistent disk; they are excluded from Git. `.env.example` documents settings; `.env` is not automatically loaded.

## What's included

- Responsive 30 × 30 board with keyboard navigation and capture animations.
- Browser guest identity, editable name, and eight player colors.
- WebSocket broadcasts, unique online-player counts, leaderboard, and territory stats.
- One-second per-player cooldown and five-second tile protection, enforced on the server.
- Version-checked captures, transactional persistence, duplicate-request handling, and reconnect snapshots.
- Zoom controls, scrollable enlarged board, reduced-motion support, and connection feedback.
- Origin checks, HttpOnly session cookies, bounded WebSocket payloads, heartbeat checks, slow-client handling, and per-connection message limits.

## Stack choices

**Vanilla JavaScript + CSS** keeps a bounded 900-cell interaction understandable, with no framework/build overhead. UI content uses DOM text APIs rather than HTML interpolation.

**Node.js + ws** provides actual bidirectional WebSockets, explicit event contracts, heartbeat handling, and connection lifecycle control. HTTP and WebSockets share one process and origin.

**SQLite in WAL mode** persists ownership and guest identities without a separate service. Short synchronous transactions keep decisions, snapshots, and broadcasts ordered within one server process. This is a smaller implementation than the original React/PostgreSQL proposal, suited to the evaluation scope.

## How a capture works

1. A same-origin session request issues a random 256-bit HttpOnly cookie. The server resolves the cookie to a player; a client-supplied player ID is never trusted.
2. On WebSocket connection the server sends a board snapshot, revision, current player, and server time. The snapshot is produced synchronously before subsequent event handlers run, so live updates follow the snapshot boundary.
3. The browser sends `{ type: "capture", id, version, requestId }` and shows a pending state. Ownership remains unconfirmed until the server responds.
4. A `BEGIN IMMEDIATE` transaction checks duplicate requests, tile version, protection, and player cooldown. It updates the tile, player timestamp, global revision, and request result together, then commits.
5. The committed event is broadcast to every socket, followed by an acknowledgement. A second claimant using the old version receives a conflict with authoritative tile state.
6. Clients reject stale versions, detect missing revisions, and resync. After disconnect they reconnect with backoff, restore their session, and receive a fresh snapshot. Requests unresolved after five seconds trigger resync rather than an unconfirmed local claim.

The database is the source of truth. If the process crashes after commit but before broadcast, all its sockets disconnect and recover from the database snapshot on reconnect. There is no outbox in this single-process design. Healthy connections use ordered, reliable WebSocket delivery; heartbeat checks detect broken connections. Duplicate results are retained for ten minutes; after that, an old version cannot overwrite a newer tile.

## Protocol

| Direction | Event | Purpose |
| --- | --- | --- |
| Client → server | `capture` | Tile ID, expected version, unique request ID |
| Client → server | `profile` | Validated display name and allowlisted color |
| Client → server | `sync` | Request a fresh board snapshot |
| Server → client | `snapshot` | Full board, revision, owners, rules, current player |
| Server → client | `captured` | Committed tile and player change with revision |
| Server → client | `result` | Success or owned/conflict/locked/cooldown/invalid |
| Server → client | `player` / `presence` | Updated identity / distinct connected players |
| Server → client | `error` | Invalid request or profile feedback |

All server events include `serverTime`. Leaderboard counts derive from ownership, avoiding separate counters that can drift.

## Code map

```text
server.js            HTTP, sessions, WebSocket transport and presence
store.js             SQLite schema, transactions, rules and persistence
public/index.html    Interface and dialogs
public/style.css     Responsive visual system and interaction states
public/app.js        Board rendering, reconciliation and controls
test/app.test.js     Store and live multi-client integration tests
```

## Validation

Tests cover competing live claims (one winner), broadcasts to both clients, cooldown across tabs, tile locks, duplicate retries, reconnect snapshots, persistence after reopening the database, malformed inputs, profile validation, session isolation, origin rejection, and private-source routes staying inaccessible. GitHub Actions runs these on Node 24.

Manual checks: use two independent browser sessions, capture from each, edit names/colors, resize, navigate tiles with arrows and Enter/Space, zoom and scroll, restart the server, and confirm sessions return to the same board.

## Deploying

Run **one Node process** on a host with persistent storage and WebSocket support. Optional Docker packaging:

```sh
docker build -t gridline .
docker run --rm -p 3000:3000 -v gridline-data:/app/data gridline
```

For public deployment, terminate TLS at a reverse proxy and configure WebSocket upgrades. Set `APP_ORIGIN` to the exact public origin (for example `https://grid.example.com`), `COOKIE_SECURE=1`, and `HOST=0.0.0.0`. Keep `DB_PATH` on persistent storage. `/health` returns `ok`. The Dockerfile is supplied but has not been container-tested in this workspace.

## Deliberate limits

- Single instance. Replicas need a shared transactional store, broadcast broker, reliable event/outbox stream, and snapshot/replay strategy. A shared SQLite network drive is not a scaling strategy.
- Limits of 500 sockets, five tabs per guest, and a per-socket token bucket are guardrails, not a measured capacity claim. No high-volume load benchmark has been performed.
- Cookies provide browser identity, not verified accounts. Clearing cookies creates another guest. Before an unrestricted public launch, add edge session/IP rate limits, abuse controls, retention policies, backups, monitoring, and load testing. Player records do not currently expire.
- Ownership is persistent; online presence is transient. Names and colors are not unique. Owner labels distinguish players.
- Mobile tiles are compact; zoom in for precise selection. Enlarged boards scroll rather than using custom drag-to-pan.

The goal is a polished end-to-end implementation with explicit real-time guarantees and clear boundaries.
