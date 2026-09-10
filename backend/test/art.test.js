import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveArt } from "../src/steam.js";

const ASSET_BASE = "https://shared.akamai.steamstatic.com/store_item_assets/";

afterEach(() => vi.restoreAllMocks());

/** A GetItems entry carrying the hashed asset manifest Steam actually returns. */
const withArt = (appid, hash = "abc123") => ({
  id: appid,
  success: 1,
  assets: {
    asset_url_format: `steam/apps/${appid}/\${FILENAME}?t=1787669881`,
    header: `${hash}/header.jpg`,
  },
});

/** An app Steam knows nothing about — no `assets` block at all. */
const withoutArt = (appid) => ({ id: appid, success: 15 });

function stubGetItems(handler) {
  const spy = vi.fn(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("IStoreBrowseService/GetItems")) {
      throw new Error(`Unexpected outbound fetch: ${url}`);
    }
    const payload = JSON.parse(decodeURIComponent(url.split("input_json=")[1]));
    const ids = payload.ids.map((i) => i.appid);
    return Response.json({ response: { store_items: handler(ids) } });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(spy);
  return spy;
}

async function run(appids, handler) {
  const spy = stubGetItems(handler);
  const ctx = createExecutionContext();
  const result = await resolveArt(appids, ctx);
  await waitOnExecutionContext(ctx);
  return { result, spy };
}

describe("resolveArt — real cover art for apps the legacy path gets wrong", () => {
  it("builds the hashed asset URL Steam actually serves", async () => {
    const { result } = await run([100001], (ids) => ids.map((id) => withArt(id, "c12d12ce")));
    expect(result["100001"]).toBe(
      `${ASSET_BASE}steam/apps/100001/c12d12ce/header.jpg?t=1787669881`,
    );
  });

  it("substitutes the filename placeholder rather than leaving it literal", async () => {
    const { result } = await run([100002], (ids) => ids.map((id) => withArt(id)));
    expect(result["100002"]).not.toContain("${FILENAME}");
    expect(result["100002"]).toContain("/header.jpg");
  });

  it("reports null for an app with no store art, so the UI can draw a tile", async () => {
    const { result } = await run([100003], (ids) => ids.map(withoutArt));
    expect(result["100003"]).toBeNull();
  });

  it("reports null for an app Steam omits from the response entirely", async () => {
    const { result } = await run([100004], () => []);
    expect(result["100004"]).toBeNull();
  });

  it("leaves ids unresolved when the lookup fails, rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const ctx = createExecutionContext();
    const result = await resolveArt([100005], ctx);
    await waitOnExecutionContext(ctx);
    // Unresolved, not null — callers fall back to the legacy URL.
    expect(result["100005"]).toBeUndefined();
  });

  it("survives a non-200 from Steam", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    const ctx = createExecutionContext();
    await expect(resolveArt([100006], ctx)).resolves.toBeTruthy();
    await waitOnExecutionContext(ctx);
  });
});

describe("resolveArt — batching", () => {
  it("splits a large library into chunks instead of one call per game", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => 200000 + i);
    const { result, spy } = await run(ids, (batch) => batch.map((id) => withArt(id)));

    // 250 ids at 100 per request — 3 calls, not 250.
    expect(spy).toHaveBeenCalledTimes(3);
    expect(Object.keys(result)).toHaveLength(250);
  });

  it("never exceeds the 100-id chunk the endpoint is called with", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => 300000 + i);
    const { spy } = await run(ids, (batch) => batch.map((id) => withArt(id)));

    for (const [input] of spy.mock.calls) {
      const url = input instanceof Request ? input.url : String(input);
      const payload = JSON.parse(decodeURIComponent(url.split("input_json=")[1]));
      expect(payload.ids.length).toBeLessThanOrEqual(100);
    }
  });

  it("de-duplicates repeated app ids", async () => {
    const { spy } = await run([400001, 400001, 400001], (batch) => batch.map((id) => withArt(id)));
    const url = String(spy.mock.calls[0][0]);
    const payload = JSON.parse(decodeURIComponent(url.split("input_json=")[1]));
    expect(payload.ids).toHaveLength(1);
  });
});

describe("resolveArt — caching", () => {
  it("does not re-ask Steam for an app it already resolved", async () => {
    await run([500001], (ids) => ids.map((id) => withArt(id)));
    const { spy, result } = await run([500001], (ids) => ids.map((id) => withArt(id)));

    expect(spy).not.toHaveBeenCalled();
    expect(result["500001"]).toContain("/header.jpg");
  });

  it("remembers that an app has no art, so it isn't looked up repeatedly", async () => {
    await run([500002], (ids) => ids.map(withoutArt));
    const { spy, result } = await run([500002], (ids) => ids.map(withoutArt));

    expect(spy).not.toHaveBeenCalled();
    expect(result["500002"]).toBeNull();
  });

  it("only fetches the ids it hasn't seen before", async () => {
    await run([500003], (ids) => ids.map((id) => withArt(id)));
    const { spy } = await run([500003, 500004], (ids) => ids.map((id) => withArt(id)));

    const url = String(spy.mock.calls[0][0]);
    const payload = JSON.parse(decodeURIComponent(url.split("input_json=")[1]));
    expect(payload.ids.map((i) => i.appid)).toEqual([500004]);
  });
});
