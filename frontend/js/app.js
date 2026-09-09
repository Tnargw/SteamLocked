// Base URL of the SteamLocked backend Worker.
const API_BASE = "https://steamlocked.grant-watson.workers.dev";

const form = document.getElementById("lookup");
const statusEl = document.getElementById("status");
const gamesEl = document.getElementById("games");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const steamid = document.getElementById("steamid").value.trim();

  statusEl.textContent = "Loading…";
  gamesEl.replaceChildren();

  try {
    const res = await fetch(`${API_BASE}/api/steam/owned-games?steamid=${steamid}`);
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = `Error: ${data.error ?? res.status}`;
      return;
    }
    if (data.private) {
      statusEl.textContent = "That profile's game details are private.";
      return;
    }

    statusEl.textContent = `${data.count} games`;
    for (const game of data.games) {
      const li = document.createElement("li");
      const hours = (game.playtimeMinutes / 60).toFixed(1);
      li.textContent = `${game.name} — ${hours} h`;
      gamesEl.appendChild(li);
    }
  } catch (err) {
    statusEl.textContent = "Could not reach the backend.";
  }
});
