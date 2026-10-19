import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createApp } from "../server.js";
import { createStore } from "../store.js";

test("capture rules, version conflicts, idempotency, rollback, and persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "grid-test-"));
  const path = join(dir, "test.sqlite");
  let store = createStore(path);
  try {
    const a = store.session();
    const b = store.session();
    const first = store.capture(
      a.player.id,
      { id: 0, version: 0, requestId: "a" },
      10000,
    );
    assert.equal(first.ok, true);
    assert.equal(first.revision, 1);
    assert.equal(
      store.capture(b.player.id, { id: 0, version: 0, requestId: "b" }, 10000)
        .code,
      "conflict",
    );
    assert.equal(
      store.capture(b.player.id, { id: 0, version: 1, requestId: "b2" }, 11000)
        .code,
      "locked",
    );
    assert.equal(
      store.capture(a.player.id, { id: 1, version: 0, requestId: "a2" }, 10500)
        .code,
      "cooldown",
    );
    assert.equal(
      store.capture(a.player.id, { id: 0, version: 1, requestId: "a3" }, 11000)
        .code,
      "owned",
    );
    assert.equal(
      store.capture(a.player.id, { id: 0, version: 0, requestId: "a" }, 12000)
        .replay,
      true,
    );
    assert.equal(store.snapshot().revision, 1);
    assert.equal(
      store.capture(b.player.id, { id: 0, version: 1, requestId: "b3" }, 15000)
        .ok,
      true,
    );
    assert.equal(
      store.capture(a.player.id, { id: -1, version: 0, requestId: "bad" }).code,
      "invalid",
    );
    assert.equal(
      store.capture(a.player.id, { id: 2, version: NaN, requestId: "bad2" })
        .code,
      "invalid",
    );
    assert.equal(store.profile(a.player.id, "", "red"), null);
    store.close();
    store = createStore(path);
    assert.equal(store.lookup(a.token).id, a.player.id);
    assert.equal(store.snapshot().tiles[0].owner, b.player.id);
    assert.equal(store.snapshot().revision, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}
async function session(url, cookie) {
  const res = await fetch(url + "/api/session", {
    method: "POST",
    headers: { Origin: url, ...(cookie ? { Cookie: cookie } : {}) },
  });
  assert.equal(res.status, 200);
  return {
    ...(await res.json()),
    cookie: res.headers.get("set-cookie").split(";")[0],
  };
}
function peer(url, cookie, origin = url) {
  const socket = new WebSocket(url.replace("http:", "ws:") + "/ws", {
    headers: { Cookie: cookie, Origin: origin },
  });
  const queue = [],
    waiters = [];
  socket.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    const index = waiters.findIndex((w) => w.predicate(m));
    if (index >= 0) {
      const w = waiters.splice(index, 1)[0];
      clearTimeout(w.timer);
      w.resolve(m);
    } else queue.push(m);
  });
  return {
    socket,
    send: (m) => socket.send(JSON.stringify(m)),
    next(predicate) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { predicate, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error("Timed out waiting for event"));
        }, 3000);
        waiters.push(w);
      });
    },
  };
}
test("two live players race, receive one winner, resync, and share tab cooldown", async () => {
  const app = createApp({ dbPath: ":memory:" });
  const url = await listen(app);
  try {
    const a = await session(url),
      b = await session(url);
    const one = peer(url, a.cookie),
      two = peer(url, b.cookie);
    const [s1, s2] = await Promise.all([
      one.next((m) => m.type === "snapshot"),
      two.next((m) => m.type === "snapshot"),
    ]);
    assert.equal(s1.tiles.length, 900);
    assert.equal(s2.revision, 0);
    one.send({ type: "capture", id: 8, version: 0, requestId: "race-a" });
    two.send({ type: "capture", id: 8, version: 0, requestId: "race-b" });
    const [r1, r2] = await Promise.all([
      one.next((m) => m.type === "result"),
      two.next((m) => m.type === "result"),
    ]);
    assert.equal(Number(r1.ok) + Number(r2.ok), 1);
    assert.equal((r1.ok ? r2 : r1).code, "conflict");
    const [c1, c2] = await Promise.all([
      one.next((m) => m.type === "captured"),
      two.next((m) => m.type === "captured"),
    ]);
    assert.equal(c1.tile.owner, c2.tile.owner);
    assert.equal(c1.revision, 1);
    const winner = r1.ok ? one : two;
    winner.send({ type: "capture", id: 9, version: 0, requestId: "too-soon" });
    assert.equal(
      (
        await winner.next(
          (m) => m.type === "result" && m.requestId === "too-soon",
        )
      ).code,
      "cooldown",
    );
    const tab = peer(url, r1.ok ? a.cookie : b.cookie);
    const s3 = await tab.next((m) => m.type === "snapshot");
    assert.equal(s3.me.lastCapture, c1.player.lastCapture);
    tab.send({
      type: "capture",
      id: 10,
      version: 0,
      requestId: "tab-cooldown",
    });
    assert.equal((await tab.next((m) => m.type === "result")).code, "cooldown");
    const req = r1.ok ? "race-a" : "race-b";
    winner.send({ type: "capture", id: 8, version: 0, requestId: req });
    assert.equal(
      (await winner.next((m) => m.type === "result" && m.requestId === req))
        .replay,
      true,
    );
    two.socket.terminate();
    const returned = peer(url, b.cookie);
    const fresh = await returned.next((m) => m.type === "snapshot");
    assert.equal(fresh.revision, 1);
    assert.equal(fresh.tiles[8].owner, c1.tile.owner);
    one.send({
      type: "profile",
      name: "<script>hello</script>",
      color: "#38bdf8",
    });
    const updated = await returned.next((m) => m.type === "player");
    assert.equal(updated.player.name, "<script>hello</script>");
    assert.equal((await fetch(url + "/")).status, 200);
    assert.equal((await fetch(url + "/store.js")).status, 404);
    assert.equal(
      (
        await fetch(url + "/api/session", {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    // A guessed/absent session cannot join the WebSocket server.
    await new Promise((resolve, reject) => {
      const unauthorized = new WebSocket(url.replace("http:", "ws:") + "/ws", {
        headers: { Origin: url },
      });
      unauthorized.on("unexpected-response", (_req, res) => {
        assert.equal(res.statusCode, 403);
        res.resume();
        unauthorized.terminate();
        resolve();
      });
      unauthorized.on("error", () => {});
      unauthorized.on("open", () =>
        reject(new Error("Unauthorized socket accepted")),
      );
    });
  } finally {
    await app.close();
  }
});
