/* Quetzalcoatl — scroll-coupled optical response
 *
 * The optical horizon is fixed to the viewport. This script measures how close
 * each foreground element is to that fixed light and writes a 0..1 value into
 * a custom property; CSS does the rest. Nothing is animated on a timer and
 * nothing moves: only opacity responds, and only to the user's own scrolling.
 *
 *   [data-qz-lit]   → --qz-lit  (body brightness)  and --qz-edge (top seam)
 *   [data-qz-rim]   → --qz-rim  (stage top rim)
 *   .qz-prose h2    → --qz-near (section rule under a reading heading)
 *
 * Usage:  <script src="scripts/optics.js" defer></script>
 * It starts itself; call window.QuetzalcoatlOptics.init(root) again after a
 * client-side navigation swaps the page content.
 * With prefers-reduced-motion the script does nothing and every property
 * keeps its CSS fallback, so the page is fully lit and static.
 */

(() => {
const clamp01 = (value) => Math.max(0, Math.min(1, value));

function initOptics(root = document) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};

  const lit = Array.from(root.querySelectorAll("[data-qz-lit]"));
  const rims = Array.from(root.querySelectorAll("[data-qz-rim]"));
  const headings = Array.from(root.querySelectorAll(".qz-prose h2"));
  if (lit.length + rims.length + headings.length === 0) return () => {};

  let ticking = false;

  const update = () => {
    ticking = false;
    const vh = window.innerHeight || 900;

    // Immersive pages: the horizon sits at 58% of the viewport height.
    const horizon = vh * 0.58;
    for (const el of lit) {
      const rect = el.getBoundingClientRect();
      const center = rect.top + rect.height * 0.45;
      el.style.setProperty("--qz-lit", clamp01(1 - Math.abs(center - horizon) / (vh * 0.78)).toFixed(3));
      el.style.setProperty("--qz-edge", clamp01(1 - Math.abs(rect.top - horizon) / (vh * 0.52)).toFixed(3));
    }
    for (const el of rims) {
      const rect = el.getBoundingClientRect();
      el.style.setProperty("--qz-rim", clamp01(1 - Math.abs(rect.top - horizon) / (vh * 0.48)).toFixed(3));
    }

    // Reading pages: the horizon sits higher (47%) with a shorter reach.
    const readingHorizon = vh * 0.47;
    const reach = vh * 0.34;
    for (const el of headings) {
      const rect = el.getBoundingClientRect();
      const center = rect.top + rect.height * 0.5;
      el.style.setProperty("--qz-near", clamp01(1 - Math.abs(center - readingHorizon) / reach).toFixed(3));
    }
  };

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(update);
  };

  update();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });

  return () => {
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initOptics(), { once: true });
} else {
  initOptics();
}

window.QuetzalcoatlOptics = { init: initOptics };
})();
