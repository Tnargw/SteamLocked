/** Thin client for the SteamLocked Worker, plus session-token storage. */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
export const API_BASE = LOCAL_HOSTS.has(location.hostname)
  ? "http://localhost:8787"
  : "https://steamlocked.grant-watson.workers.dev";

const TOKEN_KEY = "steamlocked.token";

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export const setToken = (token) => {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode — session just won't persist */
  }
};

export const clearToken = () => {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to do */
  }
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(path, { auth = false } = {}) {
  const headers = {};
  if (auth) {
    const token = getToken();
    if (!token) throw new ApiError(401, "Not signed in");
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { headers });
  } catch {
    throw new ApiError(0, "Couldn't reach the SteamLocked server.");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) clearToken();
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const loginUrl = () =>
  `${API_BASE}/auth/steam/login?return=${encodeURIComponent(location.href.split("#")[0])}`;

export const getTrending = (limit = 12) => request(`/api/steam/trending?limit=${limit}`);
export const getMe = () => request("/api/me", { auth: true });
export const getMyGames = () => request("/api/me/games", { auth: true });
export const getAchievements = (appid) =>
  request(`/api/games/${appid}/achievements`, { auth: true });

export const rollTask = (appid, { difficulty = "any", exclude = null } = {}) => {
  const params = new URLSearchParams({ difficulty });
  if (exclude) params.set("exclude", exclude);
  return request(`/api/games/${appid}/roll?${params}`, { auth: true });
};
