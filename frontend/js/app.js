/** SteamLocked — views, routing, and the roll/verify loop. */

import * as api from "./api.js";
import * as store from "./store.js";

const view = document.getElementById("view");
const accountEl = document.getElementById("account");
const toastEl = document.getElementById("toast");

let me = null; // signed-in profile, or null
let gamesCache = null; // owned games, fetched once per session

// --- tiny DOM helper ---------------------------------------------------------

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

let toastTimer;
function toast(message, kind = "info") {
  toastEl.textContent = message;
  toastEl.className = `toast toast-${kind}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 4000);
}

const TIER_LABEL = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  insane: "Insane",
  unknown: "Unrated",
};

const pct = (n) => (n === null || n === undefined ? "—" : `${n.toFixed(1)}%`);
const hours = (minutes) => (minutes / 60).toFixed(1);

function tierBadge(tier, percent) {
  return h(
    "span",
    { class: `tier tier-${tier}`, title: `${pct(percent)} of players have this` },
    TIER_LABEL[tier] ?? tier,
  );
}

function spinner(label = "Loading…") {
  return h("div", { class: "loading" }, h("span", { class: "spinner", "aria-hidden": "true" }), label);
}

function errorBox(message, retry) {
  return h(
    "div",
    { class: "panel error" },
    h("p", {}, message),
    retry && h("button", { class: "btn", onClick: retry }, "Try again"),
  );
}

// --- account strip -----------------------------------------------------------

function renderAccount() {
  accountEl.replaceChildren();
  if (!me) {
    accountEl.append(
      h("a", { class: "btn btn-steam", href: api.loginUrl() }, "Sign in through Steam"),
    );
    return;
  }
  const t = store.totals();
  accountEl.append(
    h(
      "div",
      { class: "account-inner" },
      h("span", { class: "account-stat", title: "Tasks completed" }, `${t.completed} done`),
      h("span", { class: "account-stat", title: "Active tasks" }, `${t.active} active`),
      h("img", { class: "avatar", src: me.avatar, alt: "" }),
      h("span", { class: "account-name" }, me.name),
      h("button", { class: "btn btn-ghost", onClick: signOut }, "Sign out"),
    ),
  );
}

function signOut() {
  api.clearToken();
  store.reset();
  me = null;
  gamesCache = null;
  location.hash = "#/";
  renderAccount();
  router();
  toast("Signed out.");
}

// --- landing (signed out) ----------------------------------------------------

async function renderLanding() {
  view.replaceChildren(
    h(
      "section",
      { class: "hero" },
      h("h1", {}, "One task at a time."),
      h(
        "p",
        { class: "lede" },
        "SteamLocked rolls you a random achievement you haven't earned yet — and locks it in. " +
          "No skipping ahead, no cherry-picking. Finish it in-game and Steam itself confirms the unlock.",
      ),
      h("a", { class: "btn btn-steam btn-lg", href: api.loginUrl() }, "Sign in through Steam"),
      h(
        "p",
        { class: "fine" },
        "Steam handles the login — SteamLocked never sees your password. " +
          "Your library needs its ",
        h("strong", {}, "Game details"),
        " privacy set to Public.",
      ),
    ),
    h(
      "section",
      { class: "steps" },
      ...[
        ["1", "Pick a game", "Any title in your Steam library with achievements."],
        ["2", "Roll a task", "A random locked achievement, weighted by the difficulty you choose."],
        ["3", "Go earn it", "It's the only task you can work on for that game."],
        ["4", "Verified", "SteamLocked checks the Steam API — no honour system."],
      ].map(([n, title, body]) =>
        h(
          "div",
          { class: "step" },
          h("span", { class: "step-n" }, n),
          h("h3", {}, title),
          h("p", {}, body),
        ),
      ),
    ),
    h("section", { class: "section" }, h("h2", {}, "Trending on Steam"), h("div", { id: "trending" }, spinner())),
  );

  const slot = document.getElementById("trending");
  try {
    const data = await api.getTrending(12);
    slot.replaceChildren(
      h(
        "ul",
        { class: "game-grid" },
        ...data.games.map((g) =>
          h(
            "li",
            {},
            h(
              "a",
              { class: "game-card", href: g.storeUrl, target: "_blank", rel: "noopener" },
              h("img", { src: g.headerUrl, alt: "", loading: "lazy" }),
              h(
                "div",
                { class: "game-card-body" },
                h("span", { class: "muted small" }, `#${g.rank}`),
                h("span", { class: "game-card-name" }, g.name),
                h(
                  "span",
                  { class: "muted small" },
                  [
                    g.isFree ? "Free" : g.price?.final,
                    g.peakInGame && `${g.peakInGame.toLocaleString()} peak`,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  } catch (err) {
    slot.replaceChildren(errorBox(err.message, () => renderLanding()));
  }
}

// --- library (signed in) -----------------------------------------------------

async function renderLibrary() {
  view.replaceChildren(spinner("Loading your library…"));

  let data;
  try {
    data = gamesCache ?? (gamesCache = await api.getMyGames());
  } catch (err) {
    view.replaceChildren(errorBox(err.message, renderLibrary));
    return;
  }

  if (data.private) {
    view.replaceChildren(
      h(
        "div",
        { class: "panel error" },
        h("h2", {}, "Your game details are private"),
        h(
          "p",
          {},
          "Steam won't share your library. In Steam: Profile → Edit Profile → Privacy Settings → set ",
          h("strong", {}, "Game details"),
          " to Public, then reload.",
        ),
        h("button", { class: "btn", onClick: () => ((gamesCache = null), renderLibrary()) }, "Reload"),
      ),
    );
    return;
  }

  const t = store.totals();
  const active = new Set(store.activeAppIds());

  const grid = h("ul", { class: "game-grid" });
  const search = h("input", {
    type: "search",
    class: "search",
    placeholder: `Search ${data.count} games…`,
    "aria-label": "Search your library",
    onInput: (e) => paint(e.target.value.trim().toLowerCase()),
  });

  function paint(query = "") {
    const matches = query
      ? data.games.filter((g) => g.name.toLowerCase().includes(query))
      : data.games;

    grid.replaceChildren(
      ...matches.slice(0, 240).map((g) =>
        h(
          "li",
          {},
          h(
            "a",
            { class: "game-card", href: `#/game/${g.appid}` },
            h("img", { src: g.headerUrl, alt: "", loading: "lazy" }),
            active.has(g.appid) && h("span", { class: "flag" }, "Task active"),
            h(
              "div",
              { class: "game-card-body" },
              h("span", { class: "game-card-name" }, g.name),
              h(
                "span",
                { class: "muted small" },
                g.playtimeMinutes ? `${hours(g.playtimeMinutes)} h played` : "Never played",
              ),
            ),
          ),
        ),
      ),
    );

    if (matches.length === 0) {
      grid.replaceChildren(h("li", { class: "empty" }, `No games match “${query}”.`));
    } else if (matches.length > 240) {
      grid.append(
        h("li", { class: "empty" }, `Showing 240 of ${matches.length} — refine your search.`),
      );
    }
  }

  paint();

  view.replaceChildren(
    h(
      "div",
      { class: "stat-strip" },
      h("div", { class: "stat" }, h("strong", {}, t.completed), h("span", {}, "tasks completed")),
      h("div", { class: "stat" }, h("strong", {}, t.active), h("span", {}, "active tasks")),
      h("div", { class: "stat" }, h("strong", {}, t.skipped), h("span", {}, "skipped")),
      h("div", { class: "stat" }, h("strong", {}, data.count), h("span", {}, "games owned")),
    ),
    h("div", { class: "section-head" }, h("h2", {}, "Your library"), search),
    grid,
  );
}

// --- game detail -------------------------------------------------------------

async function renderGame(appid) {
  view.replaceChildren(spinner("Loading achievements…"));

  let data;
  try {
    data = await api.getAchievements(appid);
  } catch (err) {
    view.replaceChildren(errorBox(err.message, () => renderGame(appid)));
    return;
  }

  const game = gamesCache?.games?.find((g) => g.appid === Number(appid));
  const title = data.game || game?.name || `App ${appid}`;

  const header = h(
    "div",
    { class: "game-head" },
    h("img", { class: "game-head-art", src: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`, alt: "" }),
    h(
      "div",
      {},
      h("a", { class: "back", href: "#/" }, "← Library"),
      h("h1", {}, title),
      data.available
        ? h(
            "p",
            { class: "muted" },
            `${data.unlocked} of ${data.total} achievements · ${Math.round((data.unlocked / data.total) * 100)}% complete`,
          )
        : h("p", { class: "muted" }, data.reason),
      data.available &&
        h(
          "div",
          { class: "progress", role: "progressbar", "aria-valuenow": data.unlocked, "aria-valuemin": 0, "aria-valuemax": data.total },
          h("span", { style: `width:${(data.unlocked / data.total) * 100}%` }),
        ),
    ),
  );

  const taskSlot = h("div", { class: "task-slot" });
  const listSlot = h("div", {});

  view.replaceChildren(header, taskSlot, listSlot);

  if (!data.available) return;

  paintTask(appid, data, taskSlot);
  listSlot.append(achievementList(data));
}

/** The roll / active-task / completed panel for one game. */
function paintTask(appid, data, slot) {
  const saved = store.getGame(appid);
  const byKey = new Map(data.achievements.map((a) => [a.key, a]));

  // Auto-verify: if Steam now reports the active task as unlocked, it's done.
  // Re-render the whole view so progress, counts and the list update together.
  if (saved.active && byKey.get(saved.active.key)?.unlocked) {
    const done = store.completeActive(appid);
    renderAccount();
    toast(`Task complete: ${done.name}`, "success");
    renderGame(appid);
    return;
  }

  slot.replaceChildren();

  if (saved.active) {
    const task = saved.active;
    slot.append(
      h(
        "section",
        { class: "panel task-card" },
        h("div", { class: "task-label" }, "Current task"),
        h(
          "div",
          { class: "task-main" },
          task.icon && h("img", { class: "task-icon", src: task.icon, alt: "" }),
          h(
            "div",
            {},
            h("h2", {}, task.name),
            h("p", { class: "muted" }, task.description || "No description — you're on your own."),
            h(
              "div",
              { class: "task-meta" },
              tierBadge(task.tier, task.globalPercent),
              h("span", { class: "muted small" }, `${pct(task.globalPercent)} of players have this`),
            ),
          ),
        ),
        h(
          "div",
          { class: "task-actions" },
          h(
            "button",
            { class: "btn btn-primary", onClick: (e) => verify(appid, e.currentTarget, slot) },
            "I've done it — check Steam",
          ),
          h("button", { class: "btn btn-ghost", onClick: () => skip(appid, slot) }, "Skip task"),
        ),
        h("p", { class: "fine" }, "Locked in until Steam confirms the unlock, or you skip."),
      ),
    );
  } else {
    const locked = data.total - data.unlocked;
    const select = h(
      "select",
      { class: "select", "aria-label": "Difficulty" },
      h("option", { value: "any" }, "Any difficulty"),
      h("option", { value: "easy" }, "Easy — 50%+ of players"),
      h("option", { value: "medium" }, "Medium — 20–50%"),
      h("option", { value: "hard" }, "Hard — 5–20%"),
      h("option", { value: "insane" }, "Insane — under 5%"),
    );

    slot.append(
      h(
        "section",
        { class: "panel roll-card" },
        locked === 0
          ? h(
              "div",
              { class: "done-all" },
              h("h2", {}, "100% complete"),
              h("p", { class: "muted" }, "Nothing left to roll here. Pick another game."),
            )
          : h(
              "div",
              {},
              h("h2", {}, "No active task"),
              h("p", { class: "muted" }, `${locked} achievements still locked.`),
              h(
                "div",
                { class: "roll-actions" },
                select,
                h(
                  "button",
                  {
                    class: "btn btn-primary btn-lg",
                    onClick: (e) => doRoll(appid, select.value, e.currentTarget, slot),
                  },
                  "Roll a task",
                ),
              ),
            ),
      ),
    );
  }

  if (saved.completed.length || saved.skipped) {
    slot.append(
      h(
        "section",
        { class: "panel" },
        h(
          "h3",
          {},
          `Completed here: ${saved.completed.length}`,
          saved.skipped ? h("span", { class: "muted small" }, ` · ${saved.skipped} skipped`) : null,
        ),
        saved.completed.length
          ? h(
              "ul",
              { class: "done-list" },
              ...saved.completed.slice(0, 10).map((c) =>
                h(
                  "li",
                  {},
                  c.icon && h("img", { src: c.icon, alt: "" }),
                  h("span", {}, c.name),
                  tierBadge(c.tier, c.globalPercent),
                ),
              ),
            )
          : null,
      ),
    );
  }
}

async function doRoll(appid, difficulty, button, slot) {
  button.disabled = true;
  button.textContent = "Rolling…";
  try {
    const result = await api.rollTask(appid, { difficulty });
    store.setActive(appid, result.task);
    renderAccount();
    toast(`Rolled: ${result.task.name}`, "success");
    const data = await api.getAchievements(appid);
    paintTask(appid, data, slot);
  } catch (err) {
    toast(err.message, "error");
    button.disabled = false;
    button.textContent = "Roll a task";
  }
}

async function verify(appid, button, slot) {
  button.disabled = true;
  button.textContent = "Checking Steam…";
  try {
    const data = await api.getAchievements(appid);
    const saved = store.getGame(appid);
    const current = data.achievements.find((a) => a.key === saved.active?.key);
    if (current?.unlocked) {
      paintTask(appid, data, slot); // auto-verify path completes it and re-renders
    } else {
      toast("Steam says that one's still locked. Keep at it.", "error");
      button.disabled = false;
      button.textContent = "I've done it — check Steam";
    }
  } catch (err) {
    toast(err.message, "error");
    button.disabled = false;
    button.textContent = "I've done it — check Steam";
  }
}

async function skip(appid, slot) {
  const skipped = store.skipActive(appid);
  renderAccount();
  toast(skipped ? `Skipped: ${skipped.name}` : "Task skipped.");
  try {
    const data = await api.getAchievements(appid);
    paintTask(appid, data, slot);
  } catch (err) {
    toast(err.message, "error");
  }
}

/** Browsable list of every achievement, locked ones first. */
function achievementList(data) {
  const sorted = [...data.achievements].sort(
    (a, b) => a.unlocked - b.unlocked || (b.globalPercent ?? 0) - (a.globalPercent ?? 0),
  );

  const list = h("ul", { class: "ach-list" });
  let showAll = false;

  const more = h("button", {
    class: "btn btn-ghost",
    onClick: () => {
      showAll = !showAll;
      paint();
    },
  });

  function paint() {
    const shown = showAll ? sorted : sorted.slice(0, 12);
    list.replaceChildren(
      ...shown.map((a) =>
        h(
          "li",
          { class: a.unlocked ? "ach unlocked" : "ach" },
          h("img", { src: (a.unlocked ? a.icon : a.iconGray) || a.icon, alt: "", loading: "lazy" }),
          h(
            "div",
            {},
            h("span", { class: "ach-name" }, a.name),
            h("span", { class: "muted small" }, a.description || (a.hidden ? "Hidden achievement" : "")),
          ),
          h("div", { class: "ach-right" }, tierBadge(a.tier, a.globalPercent), a.unlocked ? "✓" : ""),
        ),
      ),
    );
    more.textContent = showAll ? "Show fewer" : `Show all ${sorted.length}`;
  }

  paint();
  return h(
    "section",
    { class: "section" },
    h("h2", {}, "All achievements"),
    list,
    sorted.length > 12 ? more : null,
  );
}

// --- routing / boot ----------------------------------------------------------

function router() {
  const hash = location.hash || "#/";
  if (!me) return renderLanding();

  const gameMatch = hash.match(/^#\/game\/(\d+)$/);
  if (gameMatch) return renderGame(gameMatch[1]);
  return renderLibrary();
}

/** Pick up ?#token=… handed back by the Worker after a Steam login. */
function consumeAuthFragment() {
  const hash = location.hash.slice(1);
  if (!hash.includes("token=") && !hash.includes("error=")) return;

  const params = new URLSearchParams(hash);
  const token = params.get("token");
  const error = params.get("error");
  history.replaceState(null, "", location.pathname + location.search);

  if (token) {
    api.setToken(token);
  } else if (error) {
    toast(
      error === "verification_failed"
        ? "Steam couldn't verify that sign-in. Try again."
        : "Sign-in was cancelled.",
      "error",
    );
  }
}

async function boot() {
  consumeAuthFragment();

  if (api.getToken()) {
    try {
      me = await api.getMe();
      store.load(me.steamid);
    } catch (err) {
      me = null;
      if (err.status !== 401) toast(err.message, "error");
    }
  }

  renderAccount();
  router();
  window.addEventListener("hashchange", router);
}

boot();
