import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../js/api.js";

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => vi.unstubAllGlobals());

describe("API base URL", () => {
  it("targets the local Worker when served from localhost", () => {
    // happy-dom serves tests from localhost, which is the dev branch.
    expect(api.API_BASE).toBe("http://localhost:8787");
  });
});

describe("session token storage", () => {
  it("returns null when nothing is stored", () => {
    expect(api.getToken()).toBeNull();
  });

  it("round-trips a token", () => {
    api.setToken("abc.def");
    expect(api.getToken()).toBe("abc.def");
  });

  it("clears a token", () => {
    api.setToken("abc.def");
    api.clearToken();
    expect(api.getToken()).toBeNull();
  });

  it("returns null instead of throwing when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    expect(api.getToken()).toBeNull();
  });

  it("does not throw when storage rejects a write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => api.setToken("abc.def")).not.toThrow();
  });
});

describe("loginUrl", () => {
  it("points at the Worker's login route with an encoded return URL", () => {
    const url = new URL(api.loginUrl());
    expect(url.pathname).toBe("/auth/steam/login");
    expect(url.searchParams.get("return")).toBe(location.href.split("#")[0]);
  });

  it("strips any existing fragment from the return URL", () => {
    location.hash = "#/game/730";
    expect(new URL(api.loginUrl()).searchParams.get("return")).not.toContain("#");
    location.hash = "";
  });
});

describe("authenticated requests", () => {
  it("sends the token as a Bearer header", async () => {
    api.setToken("tok.sig");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ name: "TestPlayer" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getMe();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8787/api/me");
    expect(init.headers.Authorization).toBe("Bearer tok.sig");
  });

  it("refuses to call an authenticated route with no token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getMe()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a token the server rejects, so the UI returns to signed-out", async () => {
    api.setToken("stale.token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Session expired" }, 401)));

    await expect(api.getMe()).rejects.toMatchObject({ status: 401 });
    expect(api.getToken()).toBeNull();
  });

  it("keeps the token on a non-auth error", async () => {
    api.setToken("good.token");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Steam is down" }, 502)));

    await expect(api.getMe()).rejects.toMatchObject({ status: 502, message: "Steam is down" });
    expect(api.getToken()).toBe("good.token");
  });
});

describe("public requests", () => {
  it("fetches trending without an Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ games: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getTrending(5);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/steam/trending?limit=5");
    expect(init.headers.Authorization).toBeUndefined();
  });
});

describe("roll parameters", () => {
  beforeEach(() => api.setToken("tok.sig"));

  it("passes the chosen difficulty", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ task: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await api.rollTask(730, { difficulty: "hard" });
    expect(fetchMock.mock.calls[0][0]).toContain("difficulty=hard");
  });

  it("omits `exclude` unless a task was skipped", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ task: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await api.rollTask(730);
    expect(fetchMock.mock.calls[0][0]).not.toContain("exclude");
  });

  it("passes `exclude` when re-rolling after a skip", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ task: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await api.rollTask(730, { exclude: "RARE" });
    expect(fetchMock.mock.calls[0][0]).toContain("exclude=RARE");
  });
});

describe("network failures", () => {
  it("reports an unreachable server in plain language", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(api.getTrending()).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining("Couldn't reach"),
    });
  });

  it("falls back to a status-code message when the body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 })));

    await expect(api.getTrending()).rejects.toMatchObject({
      message: expect.stringContaining("502"),
    });
  });
});
