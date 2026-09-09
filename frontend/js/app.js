// Base URL of the SteamLocked backend Worker.
const API_BASE = "https://steamlocked.grant-watson.workers.dev";

async function checkBackend() {
  const el = document.getElementById("status");
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    el.textContent = data.ok ? "backend: online" : "backend: unexpected response";
  } catch (err) {
    el.textContent = "backend: unreachable";
  }
}

checkBackend();
