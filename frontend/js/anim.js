/**
 * Animation helpers.
 *
 * Timing logic lives here, separate from the views, so it can be tested
 * without a browser. Everything defers to `prefers-reduced-motion`: motion is
 * decoration, and the app has to work identically without it.
 */

export const prefersReducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gaps between reel frames, growing so the reel *decelerates* into its result.
 * Cubic on the gap gives a long fast blur and a slow, readable landing.
 */
export function reelIntervals({ steps = 24, from = 45, to = 420 } = {}) {
  return Array.from({ length: steps }, (_, i) => {
    const t = steps === 1 ? 1 : i / (steps - 1);
    return Math.round(from + (to - from) * t * t * t);
  });
}

/**
 * Spin a reel of candidate names until `result` settles, then land on it.
 *
 * `render` is called with each name, so this stays DOM-agnostic. The spin runs
 * for at least `minMs` even on a fast network — otherwise a quick response
 * makes the whole thing flicker and feel broken rather than deliberate. A
 * rejection stops the reel immediately; there is nothing to land on.
 */
export async function spinReel(render, names, { result, minMs = 2000, intervals } = {}) {
  const schedule = intervals ?? reelIntervals();
  const pool = names.filter(Boolean);

  let value;
  let error;
  const settled = Promise.resolve(result).then(
    (v) => {
      value = { v };
    },
    (e) => {
      error = e ?? new Error("Roll failed");
    },
  );

  if (pool.length && !prefersReducedMotion()) {
    const startedAt = Date.now();
    for (let frame = 0; ; frame += 1) {
      render(pool[frame % pool.length]);
      await sleep(schedule[Math.min(frame, schedule.length - 1)]);
      if (error) break;
      if (value && Date.now() - startedAt >= minMs) break;
    }
  }

  await settled;
  if (error) throw error;
  return value?.v;
}

/**
 * How long a count-up should run for, scaled to how far it has to travel.
 *
 * A fixed duration makes small numbers look broken: counting 0 to 3 over more
 * than a second shows four values and reads as a number being slow to appear,
 * rather than as a tick. Short journeys land quickly; long ones earn the full
 * run, capped so a huge library does not crawl.
 */
export const countDuration = (delta, { base = 800, perUnit = 30, max = 2600 } = {}) =>
  Math.min(max, base + Math.abs(delta) * perUnit);

/**
 * Tick a number up to its final value. Resolves when it lands, and always
 * leaves the exact target on screen rather than a rounding artefact.
 */
export function countUp(el, to, { from = 0, duration = countDuration(to - from), format } = {}) {
  const show = (n) => {
    el.textContent = format ? format(n) : String(n);
  };

  // A hidden page gets no animation frames at all, so animating would leave the
  // wrong number on screen indefinitely. Show the truth instead.
  const hidden = typeof document !== "undefined" && document.hidden;
  if (prefersReducedMotion() || hidden || duration <= 0 || to === from) {
    show(to);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      show(to);
      resolve();
    };
    // Safety net: if frames stop arriving mid-flight (the tab is backgrounded
    // part-way through), snap to the target rather than freezing at a partial
    // value. setTimeout still fires when requestAnimationFrame does not.
    const safety = setTimeout(finish, duration + 250);

    const step = (now) => {
      if (settled) return;
      const t = Math.min((now - startedAt) / duration, 1);
      // Ease-out cubic: fast start, gentle settle.
      const eased = 1 - (1 - t) ** 3;
      show(Math.round(from + (to - from) * eased));
      if (t < 1) requestAnimationFrame(step);
      else finish();
    };
    requestAnimationFrame(step);
  });
}

/**
 * Add a class that triggers a CSS animation and resolve when it ends.
 * Resolves immediately under reduced motion, and falls back to a timeout so a
 * missing or cancelled animation can never leave a caller hanging.
 */
export function playClass(el, className, { timeout = 1200 } = {}) {
  if (!el || prefersReducedMotion()) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener("animationend", finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    el.addEventListener("animationend", finish, { once: true });
    el.classList.add(className);
  });
}
