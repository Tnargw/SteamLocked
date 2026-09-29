/** SteamLocked — views, routing, and the roll/verify loop. */

import * as api from "./api.js";
import * as store from "./store.js";
import { hueFor, initials } from "./art.js";

const view = document.getElementById("view");
const accountEl = document.getElementById("account");
const navEl = document.getElementById("nav");
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

/**
 * Steam header art, with a generated tile for apps that have none.
 * Tools, soundtracks, betas and delisted titles stay in a library but 404 on
 * every CDN path, so a bare <img> would show a broken-image icon instead.
 */
function gameArt(game, className) {
  const frame = h("div", { class: ["art", className].filter(Boolean).join(" ") });
  const img = h("img", { src: game.headerUrl, alt: "", loading: "lazy" });
  img.addEventListener("error", () => frame.replaceChildren(artFallback(game)), { once: true });
  frame.append(img);
  return frame;
}

function artFallback(game) {
  const tile = h("div", { class: "art-fallback" }, h("span", {}, initials(game.name)));
  tile.style.setProperty("--hue", String(hueFor(game.appid)));
  return tile;
}

/**
 * Small icon that degrades to an empty tile of the same size. It swaps rather
 * than removes: these sit in fixed grid columns, so removing one would shift
 * the row's text into the icon slot.
 */
function iconImg(src, className) {
  const blank = () => h("span", { class: ["icon-blank", className].filter(Boolean).join(" ") });
  if (!src) return blank();
  const img = h("img", { src, alt: "", loading: "lazy", class: className });
  img.addEventListener("error", () => img.replaceWith(blank()), { once: true });
  return img;
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

// --- navigation --------------------------------------------------------------

const NAV = [
  ["#/", "Library", true],
  ["#/leaderboard", "Leaderboard", false],
  ["#/settings", "Settings", true],
];

function renderNav() {
  const current = location.hash || "#/";
  navEl.replaceChildren(
    ...NAV.filter(([, , needsAuth]) => me || !needsAuth).map(([href, label]) =>
      h(
        "a",
        {
          href,
          class: href === current ? "nav-link nav-current" : "nav-link",
          "aria-current": href === current ? "page" : null,
        },
        label,
      ),
    ),
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
      iconImg(me.avatar, "avatar"),
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
  renderNav();
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
              gameArt(g),
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
            gameArt(g),
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

// --- leaderboard -------------------------------------------------------------

const POINTS_BY_TIER = { insane: 100, hard: 50, medium: 25, easy: 10 };

function scoringKey() {
  return h(
    "p",
    { class: "fine" },
    "Rarer achievements are worth more: ",
    ...Object.entries(POINTS_BY_TIER).map(([tier, points]) =>
      h("span", { class: "score-key" }, `${TIER_LABEL[tier]} ${points}`),
    ),
  );
}

function leaderboardRow(entry, { isMe }) {
  return h(
    "li",
    { class: isMe ? "lb-row lb-you" : "lb-row" },
    h("span", { class: "lb-rank" }, `#${entry.rank}`),
    iconImg(entry.avatar, "lb-avatar"),
    h(
      "span",
      { class: "lb-name" },
      entry.name,
      isMe ? h("span", { class: "lb-tag" }, "you") : null,
    ),
    h("span", { class: "lb-tasks muted small" }, `${entry.tasks} done`),
    h("span", { class: "lb-points" }, entry.points.toLocaleString()),
  );
}

async function renderLeaderboard() {
  view.replaceChildren(spinner("Loading the leaderboard\u2026"));

  let data;
  try {
    data = await api.getLeaderboard(50);
  } catch (err) {
    view.replaceChildren(errorBox(err.message, renderLeaderboard));
    return;
  }

  if (data.entries.length === 0) {
    view.replaceChildren(
      h("h1", {}, "Leaderboard"),
      h(
        "section",
        { class: "panel" },
        h("h2", {}, "Nobody on the board yet"),
        h("p", { class: "muted" }, "Complete a task and you will be the first name here."),
      ),
      scoringKey(),
    );
    return;
  }

  const mine = data.me?.steamid;
  const rows = data.entries.map((entry) =>
    leaderboardRow(entry, { isMe: entry.steamid === mine }),
  );

  // Ranked, but below the visible page: show the player anyway after a break.
  const offPage = data.me && !data.entries.some((e) => e.steamid === mine);
  if (offPage) {
    rows.push(
      h("li", { class: "lb-gap", "aria-hidden": "true" }, "\u22ef"),
      leaderboardRow(data.me, { isMe: true }),
    );
  }

  let subtitle;
  if (data.me) {
    subtitle = `You are ranked #${data.me.rank} with ${data.me.points.toLocaleString()} points.`;
  } else if (me) {
    subtitle = "Complete a task to join the board.";
  } else {
    subtitle = "Sign in to see where you would rank.";
  }

  view.replaceChildren(
    h("h1", {}, "Leaderboard"),
    h("p", { class: "muted" }, subtitle),
    h("ol", { class: "lb" }, ...rows),
    scoringKey(),
  );
}

// --- settings ----------------------------------------------------------------

const LISTED_ON = "You appear on the public leaderboard.";
const LISTED_OFF = "You are hidden from the leaderboard. Your progress is still saved.";

async function renderSettings() {
  view.replaceChildren(spinner("Loading settings\u2026"));

  let settings;
  try {
    settings = await api.getSettings();
  } catch (err) {
    view.replaceChildren(errorBox(err.message, renderSettings));
    return;
  }

  const checkbox = h("input", {
    type: "checkbox",
    id: "listed",
    class: "toggle",
    checked: settings.listed,
  });
  const status = h("p", { class: "fine" }, settings.listed ? LISTED_ON : LISTED_OFF);

  checkbox.addEventListener("change", async () => {
    checkbox.disabled = true;
    status.textContent = "Saving\u2026";
    try {
      const saved = await api.setListed(checkbox.checked);
      checkbox.checked = saved.listed;
      status.textContent = saved.listed ? LISTED_ON : LISTED_OFF;
      toast("Settings saved.", "success");
    } catch (err) {
      // Put the switch back where it was, so it never lies about server state.
      checkbox.checked = !checkbox.checked;
      status.textContent = checkbox.checked ? LISTED_ON : LISTED_OFF;
      toast(err.message, "error");
    }
    checkbox.disabled = false;
  });

  view.replaceChildren(
    h("h1", {}, "Settings"),
    h(
      "section",
      { class: "panel" },
      h("h2", {}, "Leaderboard"),
      h(
        "div",
        { class: "setting-row" },
        checkbox,
        h(
          "label",
          { for: "listed" },
          h("strong", {}, "Show me on the leaderboard"),
          h(
            "span",
            { class: "muted small" },
            "Lists your Steam name, avatar and score publicly. Turning this off keeps " +
              "all your progress, it just hides you from the rankings.",
          ),
        ),
      ),
      status,
    ),
    h(
      "section",
      { class: "panel" },
      h("h2", {}, "Account"),
      h("p", { class: "muted" }, `Signed in as ${me?.name ?? "\u2014"}.`),
      h("button", { class: "btn btn-ghost", onClick: signOut }, "Sign out"),
    ),
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
    gameArt(
      {
        appid,
        name: title,
        headerUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
      },
      "game-head-art",
    ),
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

  listSlot.append(achievementList(data));
  await paintTask(appid, data, taskSlot);
}

/** The roll / active-task / completed panel for one game. */
async function paintTask(appid, data, slot) {
  const saved = store.getGame(appid);
  const byKey = new Map(data.achievements.map((a) => [a.key, a]));

  // Auto-verify: if Steam now reports the active task as unlocked, hand it to
  // the server to bank. The server re-checks Steam itself, so this is a nudge
  // rather than a claim. Re-render the whole view afterwards so progress,
  // counts and the achievement list update together.
  if (saved.active && byKey.get(saved.active.key)?.unlocked) {
    try {
      const result = await store.complete(appid);
      if (result.completed) {
        renderAccount();
        toast(`Task complete: ${result.task.name}`, "success");
        renderGame(appid);
        return;
      }
    } catch (err) {
      toast(err.message, "error");
    }
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
          iconImg(task.icon, "task-icon"),
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
            CHECK_LABEL,
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
                  iconImg(c.icon),
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
    const result = await store.roll(appid, { difficulty });
    renderAccount();
    toast(`Rolled: ${result.task.name}`, "success");
    await paintTask(appid, await api.getAchievements(appid), slot);
  } catch (err) {
    toast(err.message, "error");
    button.disabled = false;
    button.textContent = "Roll a task";
  }
}

const CHECK_LABEL = "I've done it — check Steam";

async function verify(appid, button, slot) {
  button.disabled = true;
  button.textContent = "Checking Steam…";
  try {
    // The server is the one that talks to Steam and decides.
    const result = await store.complete(appid);
    if (result.completed) {
      renderAccount();
      toast(`Task complete: ${result.task.name}`, "success");
      renderGame(appid);
      return;
    }
    toast("Steam says that one's still locked. Keep at it.", "error");
  } catch (err) {
    toast(err.message, "error");
  }
  button.disabled = false;
  button.textContent = CHECK_LABEL;
}

async function skip(appid, slot) {
  try {
    const result = await store.skip(appid);
    renderAccount();
    toast(result.skipped ? `Skipped: ${result.skipped.name}` : "Task skipped.");
    await paintTask(appid, await api.getAchievements(appid), slot);
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
          iconImg((a.unlocked ? a.icon : a.iconGray) || a.icon),
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
  renderNav();

  // The leaderboard is public, so it renders whether or not anyone is signed in.
  if (hash === "#/leaderboard") return renderLeaderboard();
  if (!me) return renderLanding();
  if (hash === "#/settings") return renderSettings();

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
      await store.load();
    } catch (err) {
      me = null;
      if (err.status !== 401) toast(err.message, "error");
    }
  }

  renderAccount();
  renderNav();
  router();
  window.addEventListener("hashchange", router);
}

boot();
