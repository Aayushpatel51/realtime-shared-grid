import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { createStore, SIZE, COOLDOWN, LOCK, COLORS } from "./store.js";

const cookie = (req) =>
  /(?:^|;\s*)grid_session=([a-f0-9]{64})(?:;|$)/.exec(
    req.headers.cookie || "",
  )?.[1];
export function createApp({
  dbPath = process.env.DB_PATH || "data/grid.sqlite",
  origin = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL,
} = {}) {
  const store = createStore(dbPath);
  const clients = new Map();
  const publicDir = new URL("./public/", import.meta.url);
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api/session" && req.method === "POST") {
        const expected = origin || `http://${req.headers.host}`;
        if (req.headers.origin !== expected) {
          res.writeHead(403).end();
          return;
        }
        const session = store.session(cookie(req));
        res.setHeader(
          "Set-Cookie",
          `grid_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`,
        );
        res.setHeader("Cache-Control", "no-store");
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ player: session.player, colors: COLORS }));
        return;
      }
      if (url.pathname === "/health") {
        res.writeHead(200).end("ok");
        return;
      }
      const files = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
      };
      const entry = files[url.pathname];
      if (!entry || !["GET", "HEAD"].includes(req.method)) {
        res.writeHead(404).end("Not found");
        return;
      }
      const body = await readFile(new URL(entry[0], publicDir));
      res.writeHead(200, {
        "Content-Type": entry[1],
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(500).end("Unable to complete request");
    }
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2048,
    perMessageDeflate: false,
  });
  const send = (ws, data) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) {
      ws.close(1013, "Please reconnect");
      return;
    }
    ws.send(JSON.stringify({ ...data, serverTime: Date.now() }));
  };
  const broadcast = (data) => {
    for (const ws of clients.keys()) send(ws, data);
  };
  const presence = () => {
    const players = [
      ...new Map([...clients.values()].map((p) => [p.id, p])).values(),
    ];
    broadcast({ type: "presence", players });
  };
  server.on("upgrade", (req, socket, head) => {
    const expected = origin || `http://${req.headers.host}`;
    const player = store.lookup(cookie(req));
    if (req.url !== "/ws" || req.headers.origin !== expected || !player) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (
      clients.size >= 500 ||
      [...clients.values()].filter((p) => p.id === player.id).length >= 5
    ) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n",
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, player),
    );
  });
  wss.on("connection", (ws, player) => {
    clients.set(ws, player);
    ws.alive = true;
    ws.on("pong", () => {
      ws.alive = true;
    });
    const snapshot = () =>
      send(ws, {
        type: "snapshot",
        ...store.snapshot(),
        me: clients.get(ws),
        size: SIZE,
        cooldown: COOLDOWN,
        lock: LOCK,
      });
    snapshot();
    presence();
    let tokens = 30,
      refill = Date.now();
    ws.on("message", (raw) => {
      const now = Date.now();
      tokens = Math.min(30, tokens + (now - refill) / 100);
      refill = now;
      if (tokens < 1) {
        ws.close(1008, "Too many requests");
        return;
      }
      tokens--;
      try {
        const m = JSON.parse(raw.toString());
        if (!m || typeof m !== "object") return;
        if (m.type === "sync") snapshot();
        else if (m.type === "profile") {
          const updated = store.profile(player.id, m.name, m.color);
          if (!updated) {
            send(ws, { type: "error", code: "profile" });
            return;
          }
          for (const [peer, p] of clients)
            if (p.id === player.id) clients.set(peer, updated);
          broadcast({ type: "player", player: updated });
          presence();
        } else if (m.type === "capture") {
          const result = store.capture(player.id, m);
          if (result.ok && !result.replay) {
            for (const [peer, p] of clients)
              if (p.id === player.id) clients.set(peer, result.player);
            broadcast({ type: "captured", ...result });
          }
          send(ws, { type: "result", ...result });
        }
      } catch (error) {
        if (!(error instanceof SyntaxError))
          console.error("Message failed:", error.message);
        send(ws, { type: "error", code: "request" });
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clients.delete(ws);
      presence();
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of clients.keys()) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 15000);
  heartbeat.unref();
  return {
    server,
    store,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const ws of clients.keys()) ws.terminate();
        wss.close();
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  app.server.listen(port, host, () =>
    console.log(`Gridline is running at http://${host}:${port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
