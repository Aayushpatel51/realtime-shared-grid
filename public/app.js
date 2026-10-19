const $ = (id) => document.getElementById(id);
let me,
  colors = [],
  players = new Map(),
  tiles = [],
  socket,
  revision = -1,
  online = [],
  offset = 0,
  nextCapture = 0,
  zoom = 1,
  selectedColor,
  reconnect = 0,
  timer,
  ready = false;
const pending = new Map();
const cells = [];
const messages = {
  owned: "This little corner is already yours.",
  conflict: "Another explorer got there first. Try another tile.",
  locked: "Fresh territory! This tile is protected for a moment.",
  cooldown: "Take a breath. Your next move is almost ready.",
  invalid: "That move could not be accepted.",
};
const now = () => Date.now() + offset;
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("visible");
  clearTimeout(timer);
  timer = setTimeout(() => $("toast").classList.remove("visible"), 3200);
}
function setConnection(text, connected = false) {
  ready = connected;
  $("connection").replaceChildren(
    Object.assign(document.createElement("i"), {}),
    document.createTextNode(text),
  );
  $("connection").classList.toggle("offline", !connected);
}
function send(message) {
  if (socket?.readyState === WebSocket.OPEN && ready) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}
function renderTile(t, animate = false) {
  const cell = cells[t.id];
  if (!cell) return;
  const owner = players.get(t.owner);
  cell.className =
    "tile" +
    (t.owner ? " owned" : "") +
    (t.owner === me.id ? " mine" : "") +
    (t.lockedUntil > now() ? " locked" : "") +
    (pending.has(t.id) ? " pending" : "");
  cell.style.setProperty("--tile-color", owner?.color || "#7c8d70");
  const x = (t.id % 30) + 1,
    y = Math.floor(t.id / 30) + 1;
  cell.setAttribute(
    "aria-label",
    `Tile ${x}, ${y}. ${owner ? `Owned by ${owner.name}` : "Unclaimed"}${t.lockedUntil > now() ? ". Protected" : ""}`,
  );
  cell.setAttribute("aria-disabled", String(!ready));
  if (animate) {
    cell.classList.remove("just-captured");
    void cell.offsetWidth;
    cell.classList.add("just-captured");
  }
}
function renderStats() {
  const counts = new Map();
  for (const t of tiles)
    if (t.owner) counts.set(t.owner, (counts.get(t.owner) || 0) + 1);
  const ranked = [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const mine = counts.get(me.id) || 0;
  $("my-tiles").textContent = mine;
  $("my-share").replaceChildren(
    document.createTextNode((mine / 9).toFixed(1)),
    Object.assign(document.createElement("span"), { textContent: "%" }),
  );
  $("claimed-count").textContent = [...counts.values()].reduce(
    (a, b) => a + b,
    0,
  );
  $("leaderboard").replaceChildren();
  $("territory-bar").replaceChildren();
  if (!ranked.length)
    $("leaderboard").append(
      Object.assign(document.createElement("p"), {
        className: "empty-state",
        textContent: "A blank canvas. Be the first to claim it.",
      }),
    );
  for (const [index, [id, count]] of ranked.entries()) {
    const p = players.get(id);
    if (!p) continue;
    const bar = document.createElement("span");
    bar.style.setProperty("--tile-color", p.color);
    bar.style.width = `${count / 9}%`;
    $("territory-bar").append(bar);
    if (index >= 5) continue;
    const row = document.createElement("div");
    row.className = "leader-row";
    row.style.setProperty("--tile-color", p.color);
    const name = Object.assign(document.createElement("span"), {
      className: "leader-name",
      textContent: p.name,
    });
    if (id === me.id)
      name.append(
        Object.assign(document.createElement("small"), { textContent: "you" }),
      );
    row.append(
      Object.assign(document.createElement("span"), {
        className: "rank",
        textContent: String(index + 1).padStart(2, "0"),
      }),
      Object.assign(document.createElement("i"), {
        className: "leader-swatch",
      }),
      name,
      Object.assign(document.createElement("span"), {
        className: "leader-score",
        textContent: count,
      }),
    );
    $("leaderboard").append(row);
  }
}
function renderMe() {
  document.documentElement.style.setProperty("--me", me.color);
  $("player-name").textContent = me.name;
  $("avatar").textContent = me.name.charAt(0).toUpperCase();
}
function updateTile(t, animate = false) {
  if (!tiles[t.id] || t.version >= tiles[t.id].version) {
    tiles[t.id] = t;
    renderTile(t, animate);
  }
}
function sync() {
  if (socket?.readyState === WebSocket.OPEN) {
    ready = false;
    socket.send(JSON.stringify({ type: "sync" }));
  }
}
function connect() {
  setConnection(reconnect ? "Reconnecting" : "Connecting");
  socket = new WebSocket(
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
  );
  socket.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    offset = m.serverTime - Date.now();
    if (m.type === "snapshot") {
      me = m.me;
      players = new Map(m.players.map((p) => [p.id, p]));
      players.set(me.id, me);
      tiles = m.tiles;
      revision = m.revision;
      nextCapture = me.lastCapture + m.cooldown;
      pending.clear();
      reconnect = 0;
      setConnection("Connected", true);
      $("loading").hidden = true;
      renderMe();
      tiles.forEach((t) => renderTile(t));
      renderStats();
    } else if (m.type === "presence") {
      online = m.players;
      online.forEach((p) => players.set(p.id, p));
      $("online-count").textContent = online.length;
      $("online-avatars").replaceChildren();
      for (const p of online.slice(0, 4)) {
        const el = document.createElement("span");
        el.className = "mini-avatar";
        el.style.setProperty("--tile-color", p.color);
        el.textContent = p.name.charAt(0).toUpperCase();
        el.title = p.name;
        $("online-avatars").append(el);
      }
    } else if (m.type === "player") {
      players.set(m.player.id, m.player);
      if (m.player.id === me.id) {
        me = m.player;
        renderMe();
        $("profile-dialog").close();
        toast("A fresh identity. Same little empire.");
      }
      tiles.forEach((t) => {
        if (t.owner === m.player.id) renderTile(t);
      });
      renderStats();
    } else if (m.type === "captured") {
      if (m.revision <= revision) return;
      if (m.revision !== revision + 1) {
        sync();
        return;
      }
      revision = m.revision;
      players.set(m.player.id, m.player);
      if (m.player.id === me.id) {
        nextCapture = m.player.lastCapture + 1000;
        me.lastCapture = m.player.lastCapture;
      }
      pending.delete(m.tile.id);
      updateTile(m.tile, true);
      renderStats();
      $("activity-text").textContent =
        `${m.player.id === me.id ? "You" : m.player.name} claimed tile ${(m.tile.id % 30) + 1}, ${Math.floor(m.tile.id / 30) + 1}.`;
    } else if (m.type === "result") {
      for (const [id, request] of pending)
        if (request.id === m.requestId) {
          pending.delete(id);
          if (tiles[id]) renderTile(tiles[id]);
        }
      if (m.ok && m.replay) {
        sync();
        return;
      }
      if (!m.ok) {
        if (m.tile) updateTile(m.tile);
        if (m.code === "cooldown") nextCapture = m.retryAt;
        toast(messages[m.code] || "Please try that move again.");
        renderStats();
      }
    } else if (m.type === "error") {
      toast(
        m.code === "profile"
          ? "Choose a name of 1–24 characters and a color."
          : "That request could not be completed.",
      );
      sync();
    }
  };
  socket.onclose = () => {
    setConnection("Reconnecting");
    pending.clear();
    tiles.forEach((t) => renderTile(t));
    $("loading").hidden = false;
    $("loading").textContent = "Connection lost. Finding our way back…";
    setTimeout(
      async () => {
        try {
          await session();
          connect();
        } catch {
          connect();
        }
      },
      Math.min(1000 * 2 ** reconnect++, 15000) + Math.random() * 500,
    );
  };
  socket.onerror = () => socket.close();
}
function capture(id) {
  if (!ready) {
    toast("Reconnecting. Your next move will be ready soon.");
    return;
  }
  const t = tiles[id];
  if (!t || pending.has(id)) return;
  if (t.owner === me.id) {
    toast(messages.owned);
    return;
  }
  if (t.lockedUntil > now()) {
    toast(
      `Protected for ${Math.ceil((t.lockedUntil - now()) / 1000)} more seconds.`,
    );
    return;
  }
  if (nextCapture > now()) {
    toast(messages.cooldown);
    return;
  }
  const requestId = crypto.randomUUID();
  if (send({ type: "capture", id, version: t.version, requestId })) {
    pending.set(id, { id: requestId, sent: Date.now() });
    renderTile(t);
  }
}
for (let i = 0; i < 900; i++) {
  const cell = document.createElement("button");
  cell.className = "tile";
  cell.type = "button";
  cell.setAttribute("role", "gridcell");
  cell.setAttribute("aria-rowindex", Math.floor(i / 30) + 1);
  cell.setAttribute("aria-colindex", (i % 30) + 1);
  cell.tabIndex = i === 0 ? 0 : -1;
  cell.addEventListener("click", () => capture(i));
  const info = () => {
    const t = tiles[i],
      p = t && players.get(t.owner);
    $("tile-info").textContent =
      `${String((i % 30) + 1).padStart(2, "0")}, ${String(Math.floor(i / 30) + 1).padStart(2, "0")} · ${p?.name || "Open territory"}`;
  };
  cell.addEventListener("mouseenter", info);
  cell.addEventListener("focus", info);
  cell.addEventListener("keydown", (event) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -30, ArrowDown: 30 }[
      event.key
    ];
    if (!delta) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(899, i + delta));
    cell.tabIndex = -1;
    cells[next].tabIndex = 0;
    cells[next].focus();
  });
  cells.push(cell);
  $("board").append(cell);
}
function setZoom(value) {
  zoom = Math.max(1, Math.min(2.5, value));
  $("board").style.width = `${zoom * 100}%`;
  $("board").style.maxWidth = zoom > 1 ? "none" : "";
  $("zoom-value").textContent = `${Math.round(zoom * 100)}%`;
  $("zoom-out").disabled = zoom === 1;
  $("zoom-in").disabled = zoom === 2.5;
}
$("zoom-in").onclick = () => setZoom(zoom + 0.25);
$("zoom-out").onclick = () => setZoom(zoom - 0.25);
$("reset-view").onclick = () => {
  setZoom(1);
  $("viewport").scrollTo(0, 0);
};
setZoom(1);
$("edit-profile").onclick = () => {
  if (!ready) {
    toast("Connect to the board before changing your identity.");
    return;
  }
  $("name-input").value = me.name;
  selectedColor = me.color;
  $("color-options").replaceChildren();
  for (const [index, color] of colors.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-choice";
    button.style.setProperty("--tile-color", color);
    button.setAttribute(
      "aria-label",
      ["Lime", "Sky", "Rose", "Violet", "Amber", "Teal", "Orange", "Indigo"][
        index
      ],
    );
    button.setAttribute("aria-checked", String(color === selectedColor));
    button.setAttribute("role", "radio");
    button.onclick = () => {
      selectedColor = color;
      for (const b of $("color-options").children)
        b.setAttribute("aria-checked", String(b === button));
    };
    $("color-options").append(button);
  }
  $("color-options").setAttribute("role", "radiogroup");
  $("color-options").setAttribute("aria-label", "Player color");
  $("profile-dialog").showModal();
};
$("profile-form").onsubmit = (event) => {
  event.preventDefault();
  if (
    !send({
      type: "profile",
      name: $("name-input").value,
      color: selectedColor,
    })
  )
    toast("Reconnect before saving your identity.");
};
$("rules-button").onclick = () => $("rules-dialog").showModal();
document
  .querySelectorAll(".close-dialog")
  .forEach(
    (button) => (button.onclick = () => button.closest("dialog").close()),
  );
setInterval(() => {
  const remaining = Math.max(0, nextCapture - now());
  $("cooldown-fill").style.width = `${Math.max(0, 100 - remaining / 10)}%`;
  $("ready-text").textContent = !ready
    ? "Waiting for connection"
    : remaining
      ? "Your next move is coming"
      : "Ready to make a mark";
  $("ready-time").textContent = remaining
    ? `${(remaining / 1000).toFixed(1)}s`
    : "↗";
  for (const t of tiles)
    if (t.lockedUntil <= now() && cells[t.id].classList.contains("locked"))
      renderTile(t);
  if ([...pending.values()].some((p) => Date.now() - p.sent > 5000)) {
    pending.clear();
    toast("Checking your last move with the board…");
    sync();
  }
}, 100);
async function session() {
  const response = await fetch("/api/session", { method: "POST" });
  if (!response.ok) throw new Error("Unable to start session");
  const data = await response.json();
  me = data.player;
  colors = data.colors;
  players.set(me.id, me);
  renderMe();
}
async function start() {
  try {
    await session();
    connect();
  } catch {
    setConnection("Connection unavailable");
    $("loading").textContent = "Unable to connect. Retrying shortly…";
    setTimeout(start, 3000);
  }
}
start();
