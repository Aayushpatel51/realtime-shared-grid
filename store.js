import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SIZE = 30;
export const COOLDOWN = 1000;
export const LOCK = 5000;
export const COLORS = [
  "#a3e635",
  "#38bdf8",
  "#fb7185",
  "#c084fc",
  "#fbbf24",
  "#2dd4bf",
  "#fb923c",
  "#818cf8",
];

export function createStore(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, token TEXT UNIQUE, name TEXT, color TEXT, last_capture INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tiles(id INTEGER PRIMARY KEY, owner TEXT REFERENCES players(id), version INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS board(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER DEFAULT 0);
    INSERT OR IGNORE INTO board(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS requests(player TEXT, request TEXT, result TEXT, created INTEGER, PRIMARY KEY(player,request));`);
  const seed = db.prepare("INSERT OR IGNORE INTO tiles(id) VALUES(?)");
  db.exec("BEGIN");
  for (let i = 0; i < SIZE * SIZE; i++) seed.run(i);
  db.exec("COMMIT");
  const publicPlayer = (p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    lastCapture: p.last_capture,
  });
  const tile = (id) => {
    const t = db.prepare("SELECT * FROM tiles WHERE id=?").get(id);
    return (
      t && {
        id: t.id,
        owner: t.owner,
        version: t.version,
        lockedUntil: t.locked_until,
      }
    );
  };
  return {
    db,
    session(token) {
      let p =
        token && db.prepare("SELECT * FROM players WHERE token=?").get(token);
      if (!p) {
        const id = randomUUID();
        token = randomBytes(32).toString("hex");
        const count = db.prepare("SELECT COUNT(*) AS n FROM players").get().n;
        db.prepare(
          "INSERT INTO players(id,token,name,color) VALUES(?,?,?,?)",
        ).run(
          id,
          token,
          `Explorer ${count + 1}`,
          COLORS[count % COLORS.length],
        );
        p = db.prepare("SELECT * FROM players WHERE id=?").get(id);
      }
      return { token, player: publicPlayer(p) };
    },
    lookup(token) {
      const p = db
        .prepare("SELECT * FROM players WHERE token=?")
        .get(token || "");
      return p && publicPlayer(p);
    },
    profile(id, name, color) {
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.trim().length > 24 ||
        !COLORS.includes(color)
      )
        return null;
      name = name.trim().replace(/[\u0000-\u001f\u007f]/g, "");
      if (!name) return null;
      db.prepare("UPDATE players SET name=?,color=? WHERE id=?").run(
        name,
        color,
        id,
      );
      return publicPlayer(
        db.prepare("SELECT * FROM players WHERE id=?").get(id),
      );
    },
    snapshot() {
      return {
        revision: db.prepare("SELECT revision FROM board").get().revision,
        tiles: db
          .prepare("SELECT id FROM tiles ORDER BY id")
          .all()
          .map((t) => tile(t.id)),
        players: db
          .prepare(
            "SELECT * FROM players WHERE id IN (SELECT owner FROM tiles) ORDER BY id",
          )
          .all()
          .map(publicPlayer),
      };
    },
    capture(player, message, now = Date.now()) {
      const { id, version, requestId } = message;
      if (
        !Number.isInteger(id) ||
        id < 0 ||
        id >= SIZE * SIZE ||
        !Number.isInteger(version) ||
        version < 0 ||
        typeof requestId !== "string" ||
        !/^[\w-]{1,80}$/.test(requestId)
      ) {
        return {
          ok: false,
          code: "invalid",
          requestId:
            typeof requestId === "string" ? requestId.slice(0, 80) : null,
        };
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = db
          .prepare("SELECT result FROM requests WHERE player=? AND request=?")
          .get(player, requestId);
        if (previous) {
          db.exec("COMMIT");
          return { ...JSON.parse(previous.result), replay: true };
        }
        const p = db.prepare("SELECT * FROM players WHERE id=?").get(player);
        const t = tile(id);
        let result = { ok: false, requestId, tile: t };
        if (t.owner === player) result.code = "owned";
        else if (t.version !== version) result.code = "conflict";
        else if (t.lockedUntil > now) {
          result.code = "locked";
          result.retryAt = t.lockedUntil;
        } else if (p.last_capture + COOLDOWN > now) {
          result.code = "cooldown";
          result.retryAt = p.last_capture + COOLDOWN;
        } else {
          db.prepare(
            "UPDATE tiles SET owner=?,version=version+1,locked_until=? WHERE id=?",
          ).run(player, now + LOCK, id);
          db.prepare("UPDATE players SET last_capture=? WHERE id=?").run(
            now,
            player,
          );
          db.exec("UPDATE board SET revision=revision+1 WHERE id=1");
          result = {
            ok: true,
            requestId,
            tile: tile(id),
            revision: db.prepare("SELECT revision FROM board").get().revision,
            player: { ...publicPlayer(p), lastCapture: now },
          };
        }
        db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(
          player,
          requestId,
          JSON.stringify(result),
          now,
        );
        // A ten-minute idempotency window bounds storage. Older retries must resync.
        db.prepare("DELETE FROM requests WHERE created < ?").run(now - 600000);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}
