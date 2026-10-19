# Real-time Shared Grid

A multiplayer board where anyone can capture tiles and see ownership changes instantly.

> Status: project brief and proposed architecture. Application implementation has not started.

## Core requirements

- Display hundreds of interactive tiles (initial target: 30 × 30, or 900 tiles).
- Represent unclaimed tiles and tiles owned by a player.
- Assign a tile to a player on an accepted click and broadcast the change to all connected clients.
- Support simultaneous players and resolve competing claims on the server.
- Provide a clean, responsive UI with clear ownership, hover/focus states, and smooth feedback.

## Proposed stack and rationale

- **React + TypeScript + Vite:** responsive, component-based UI with shared typed event contracts.
- **Node.js + TypeScript + Socket.IO:** bidirectional updates, acknowledgements, connection lifecycle, and reconnect handling.
- **PostgreSQL:** durable ownership, transactional updates, and conflict resolution across concurrent requests.
- **CSS:** a lightweight visual system with accessible colors, keyboard controls, and reduced-motion support.

This stack is a proposal, not an implemented dependency list.

## Gameplay scope

Start with guest players who receive a server-issued session identity, display name, and color. Store the session in an HttpOnly cookie. Names and colors are presentation metadata, never proof of identity.

A capture replaces the current owner if the tile is unlocked and the player's cooldown has expired. Proposed defaults: a 1-second player cooldown and a 5-second tile lock after capture. Clicking your own tile is a no-op. The server controls all timing and ownership decisions.

Optional additions: leaderboard, online count, activity feed, zoom/pan, and territory statistics.

## Real-time and conflict handling

1. On connection, authenticate the guest session and send a board snapshot containing a board revision and server time.
2. The client sends a capture request with tile ID, expected tile version, and a unique request ID. It cannot select its owner ID.
3. In one transaction, lock the player row, enforce cooldown, and conditionally update the tile only if its expected version matches and its lock has expired. Use a consistent lock order to avoid deadlocks.
4. Exactly one simultaneous request for the same tile version succeeds. Reject others with the authoritative tile state so clients can reconcile.
5. Commit the tile, cooldown, deduplication result, board revision, and outbox event together. Publish committed events to all clients. A worker retries outbox delivery; clients deduplicate repeated events.
6. Acknowledge every request with success or a structured error. Show a pending state while waiting; permanent ownership is confirmed by the server.
7. Clients ignore stale tile versions and request a fresh snapshot after reconnect or a revision gap. Snapshot and live-event handoff must share a revision boundary to avoid missing updates.

Start with one backend instance. Before horizontal scaling, add a shared Socket.IO adapter and shared rate limiting; PostgreSQL remains the ownership authority. Presence counts connections per player to avoid double-counting multiple tabs.

## Suggested data model

- `players`: ID, session reference, display name, color, last capture time.
- `tiles`: ID, coordinates, nullable owner ID, version, captured time, locked-until time.
- `capture_requests`: player ID + request ID unique key, outcome, expiration.
- `board_state`: board revision.
- `outbox`: committed event ID, revision, payload, delivery state.

Leaderboard totals should derive from authoritative ownership. Avoid independent counters unless updated transactionally.

## UI direction

Keep the board as the visual focus, with a compact identity bar and connection status. Use consistent tile spacing, subtle capture animations, and a concise leaderboard. Show owner names on focus/hover and provide a non-color ownership indicator. Include reconnecting, cooldown, locked-tile, and conflict feedback. Support keyboard navigation and mobile touch targets.

## Validation plan

- Race many players against one tile version; assert exactly one accepted capture.
- Race one player against different tiles; verify cooldown cannot be bypassed.
- Retry an acknowledged or timed-out request; verify idempotency.
- Disconnect/reconnect and verify the final board matches the database.
- Verify stale/out-of-order/duplicate updates cannot roll ownership backward.
- Restart the backend and confirm ownership persists and outbox events recover.
- Use multiple browser sessions to verify broadcasts and identity isolation.
- Check responsive layout, keyboard interaction, reduced motion, and connection-loss feedback.

## Implementation milestones

1. Define shared event contracts, schema, sessions, and capture rules.
2. Build transactional capture handling with concurrency and idempotency tests.
3. Add snapshots, broadcasts, outbox delivery, and reconnect reconciliation.
4. Build and polish the interactive board and player feedback.
5. Add integration tests, load checks, setup instructions, and deployment notes.

## Evaluation priorities

A small, complete implementation with clear system decisions, reliable real-time behavior, polished interactions, and readable code takes priority over optional features.
