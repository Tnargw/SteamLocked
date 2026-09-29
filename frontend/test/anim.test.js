import { afterEach, describe, expect, it, vi } from "vitest";
import { countUp, playClass, prefersReducedMotion, reelIntervals, spinReel } from "../js/anim.js";

/** Pretend the viewer has asked for reduced motion. */
function reduceMotion(reduce) {
  vi.stubGlobal("matchMedia", (query) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prefersReducedMotion", () => {
  it("reports the viewer's preference", () => {
    reduceMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    reduceMotion(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("assumes motion is fine if matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("reelIntervals", () => {
  it("grows, so the reel slows down rather than speeding up", () => {
    const gaps = reelIntervals();
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    }
  });

  it("spans the requested range", () => {
    const gaps = reelIntervals({ steps: 10, from: 40, to: 300 });
    expect(gaps).toHaveLength(10);
    expect(gaps[0]).toBe(40);
    expect(gaps.at(-1)).toBe(300);
  });

  it("front-loads the fast frames, so most of the spin reads as a blur", () => {
    const gaps = reelIntervals({ steps: 20, from: 40, to: 300 });
    const midpoint = gaps[Math.floor(gaps.length / 2)];
    // Cubic easing: halfway through the frames we are still near the fast end.
    expect(midpoint).toBeLessThan((40 + 300) / 2);
  });

  it("handles a single step without dividing by zero", () => {
    expect(reelIntervals({ steps: 1, from: 40, to: 300 })).toEqual([300]);
  });
});

describe("spinReel", () => {
  const fast = { intervals: [1], minMs: 0 };

  it("returns whatever the roll resolved to", async () => {
    const landed = await spinReel(() => {}, ["A", "B"], {
      result: Promise.resolve({ task: { name: "Rare Task" } }),
      ...fast,
    });
    expect(landed.task.name).toBe("Rare Task");
  });

  it("cycles through the candidate names while it waits", async () => {
    reduceMotion(false);
    const seen = [];
    let release;
    const result = new Promise((r) => (release = r));
    setTimeout(() => release({ task: { name: "Winner" } }), 40);

    await spinReel((name) => seen.push(name), ["A", "B", "C"], {
      result,
      intervals: [2],
      minMs: 0,
    });

    expect(seen.length).toBeGreaterThan(1);
    // Cycles rather than stopping at the end of the list.
    expect(new Set(seen)).toEqual(new Set(["A", "B", "C"]));
  });

  it("keeps spinning until the minimum, so a fast reply still feels deliberate", async () => {
    reduceMotion(false);
    const startedAt = Date.now();
    await spinReel(() => {}, ["A"], {
      result: Promise.resolve("done"), // already settled
      intervals: [2],
      minMs: 60,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(55);
  });

  it("stops immediately when the roll is rejected", async () => {
    reduceMotion(false);
    const startedAt = Date.now();
    await expect(
      spinReel(() => {}, ["A"], {
        result: Promise.reject(new Error("already have an active task")),
        intervals: [2],
        minMs: 5000, // would spin for ages if a rejection did not short-circuit
      }),
    ).rejects.toThrow(/active task/);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("skips the spin entirely under reduced motion", async () => {
    reduceMotion(true);
    const render = vi.fn();
    const landed = await spinReel(render, ["A", "B"], {
      result: Promise.resolve("done"),
      minMs: 5000,
    });
    expect(render).not.toHaveBeenCalled();
    expect(landed).toBe("done");
  });

  it("does not spin when there are no candidates to show", async () => {
    reduceMotion(false);
    const render = vi.fn();
    await spinReel(render, [], { result: Promise.resolve("done"), minMs: 5000 });
    expect(render).not.toHaveBeenCalled();
  });

  it("ignores blank candidate names", async () => {
    reduceMotion(false);
    const seen = [];
    await spinReel((n) => seen.push(n), [null, "Real", undefined], {
      result: Promise.resolve("done"),
      ...fast,
    });
    expect(seen.every((n) => n === "Real")).toBe(true);
  });
});

describe("countUp", () => {
  const el = () => document.createElement("span");

  it("lands on exactly the target value", async () => {
    reduceMotion(false);
    const node = el();
    await countUp(node, 42, { duration: 20 });
    expect(node.textContent).toBe("42");
  });

  it("jumps straight to the value under reduced motion", async () => {
    reduceMotion(true);
    const node = el();
    await countUp(node, 1234, { duration: 5000 });
    expect(node.textContent).toBe("1234");
  });

  it("applies a formatter to the final value", async () => {
    reduceMotion(true);
    const node = el();
    await countUp(node, 1234, { format: (n) => n.toLocaleString("en-US") });
    expect(node.textContent).toBe("1,234");
  });

  it("handles zero without animating to nothing", async () => {
    reduceMotion(false);
    const node = el();
    await countUp(node, 0, { duration: 20 });
    expect(node.textContent).toBe("0");
  });

  it("shows the real value when the page gets no animation frames", async () => {
    // Regression: a hidden tab never fires requestAnimationFrame, which used to
    // leave the number frozen at 0 — displaying data that was simply wrong.
    reduceMotion(false);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    const node = el();
    await countUp(node, 99, { duration: 5000 });
    expect(node.textContent).toBe("99");
  });

  it("snaps to the target if frames stop arriving part-way through", async () => {
    reduceMotion(false);
    // One frame, then silence — as happens when a tab is backgrounded mid-flight.
    let calls = 0;
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      if (calls++ === 0) setTimeout(() => cb(performance.now()), 0);
      return calls;
    });

    const node = el();
    await countUp(node, 77, { duration: 30 });
    expect(node.textContent).toBe("77");
  });

  it("never overshoots the target mid-flight", async () => {
    reduceMotion(false);
    const node = el();
    const seen = [];
    const observer = setInterval(() => seen.push(Number(node.textContent)), 2);
    await countUp(node, 50, { duration: 60 });
    clearInterval(observer);
    expect(seen.every((n) => n >= 0 && n <= 50)).toBe(true);
  });
});

describe("playClass", () => {
  it("adds the class and resolves when the animation ends", async () => {
    reduceMotion(false);
    const node = document.createElement("div");
    const done = playClass(node, "spin");
    expect(node.classList.contains("spin")).toBe(true);
    node.dispatchEvent(new Event("animationend"));
    await expect(done).resolves.toBeUndefined();
  });

  it("resolves via the timeout if no animation ever fires", async () => {
    reduceMotion(false);
    const node = document.createElement("div");
    await expect(playClass(node, "spin", { timeout: 20 })).resolves.toBeUndefined();
  });

  it("resolves immediately and adds nothing under reduced motion", async () => {
    reduceMotion(true);
    const node = document.createElement("div");
    await playClass(node, "spin", { timeout: 5000 });
    expect(node.classList.contains("spin")).toBe(false);
  });

  it("tolerates a missing element, so callers need no null checks", async () => {
    reduceMotion(false);
    await expect(playClass(null, "spin")).resolves.toBeUndefined();
  });
});
