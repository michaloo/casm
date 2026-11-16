// Touch screens have no hover, so entry times are revealed by swiping the
// transcript right: the rows follow the finger (easing into a cap at the
// gutter width) and every entry's time shows in the uncovered left gutter,
// like the desktop one. On release they spring back. Only a clearly
// horizontal drag counts; vertical scrolling stays native.
const GUTTER = 72;
// Leave the screen edge to the system's back gesture.
const EDGE = 24;
// Movement before the direction is decided, and how horizontal it must be.
const SLOP = 8;
const RATIO = 1.5;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
// 1:1 for the first part, then ease into the cap without a kink.
const KNEE = GUTTER * 0.6;
const ease = (dx: number) => (dx <= KNEE ? Math.max(0, dx) : KNEE + (GUTTER - KNEE) * (1 - Math.exp(-(dx - KNEE) / (GUTTER - KNEE))));

/** Whether a swipe right from here would scroll content (a code block, a wide table) instead. */
function scrollsLeft(from: Element | null, root: Element) {
  for (let el = from; el && el !== root; el = el.parentElement) {
    if (el.scrollLeft > 0 && el.scrollWidth > el.clientWidth) return true;
  }
  return false;
}

/** Attach to the transcript box; `swiping()` tells other touch handlers to stand aside. Returns a cleanup. */
export function swipeTimes(box: HTMLElement) {
  let start: { x: number; y: number } | undefined;
  let locked = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const show = (x: number) => {
    clearTimeout(settle);
    box.dataset.times = "drag";
    box.style.setProperty("--times-x", `${x}px`);
    box.style.setProperty("--times-shown", String(Math.min(1, x / (GUTTER * 0.8))));
  };
  const hide = () => {
    if (!box.dataset.times) return;
    if (reduced()) return clear();
    box.dataset.times = "release";
    box.style.setProperty("--times-x", "0px");
    box.style.setProperty("--times-shown", "0");
    settle = setTimeout(clear, 260);
  };
  const clear = () => {
    clearTimeout(settle);
    delete box.dataset.times;
    box.style.removeProperty("--times-x");
    box.style.removeProperty("--times-shown");
  };
  const down = (e: TouchEvent) => {
    start = undefined;
    locked = false;
    if (e.touches.length !== 1) return hide();
    const t = e.touches[0]!;
    const target = e.target as Element;
    if (t.clientX < EDGE || target.closest("input, textarea, [contenteditable]") || scrollsLeft(target, box)) return;
    // Dragging a text selection's handles is not a swipe.
    const selection = getSelection();
    if (selection && !selection.isCollapsed && box.contains(selection.anchorNode)) return;
    start = { x: t.clientX, y: t.clientY };
  };
  const move = (e: TouchEvent) => {
    if (!start) return;
    if (e.touches.length !== 1) { start = undefined; return hide(); }
    const t = e.touches[0]!;
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    if (!locked) {
      if (Math.hypot(dx, dy) < SLOP) {
        // Undecided but leaning right: keep the browser from starting a scroll.
        if (dx > Math.abs(dy) && e.cancelable) e.preventDefault();
        return;
      }
      if (dx <= 0 || Math.abs(dx) < Math.abs(dy) * RATIO) { start = undefined; return; }
      locked = true;
    }
    if (e.cancelable) e.preventDefault();
    show(reduced() ? GUTTER : ease(dx));
  };
  const up = () => {
    start = undefined;
    if (locked) hide();
    locked = false;
  };
  box.addEventListener("touchstart", down, { passive: true });
  box.addEventListener("touchmove", move, { passive: false });
  box.addEventListener("touchend", up, { passive: true });
  box.addEventListener("touchcancel", up, { passive: true });
  return {
    swiping: () => locked,
    stop() {
      box.removeEventListener("touchstart", down);
      box.removeEventListener("touchmove", move);
      box.removeEventListener("touchend", up);
      box.removeEventListener("touchcancel", up);
      clear();
    },
  };
}
