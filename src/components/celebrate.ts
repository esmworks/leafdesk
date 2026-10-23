"use client";

/**
 * Confetti over the whole window for a moment, drawn on a canvas of its own that removes itself
 * (an automation's "celebrate" step, see lib/celebrate-event). With reduced motion asked for, a
 * short still note says it instead. `label` is what screen readers hear either way.
 */

const DURATION_MS = 2_600;
const PIECES = 150;
const GRAVITY = 0.32;
const DRAG = 0.985;
/** Bright enough on light and dark pages alike. */
const COLORS = ["#f43f5e", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6"];

type Piece = { x: number; y: number; vx: number; vy: number; angle: number; spin: number; w: number; h: number; color: string; wobble: number };

let playing = false;

export function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function celebrate(label: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (prefersReducedMotion()) {
    stillNote(label);
    return;
  }
  // One at a time: two changes in a row make one burst, not a pile of canvases.
  if (playing) return;
  playing = true;
  announce(label);
  confetti();
}

/** Two bursts from the bottom corners, falling back down past the bottom edge. */
function confetti() {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483000";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const pieces: Piece[] = Array.from({ length: PIECES }, (_, i) => {
    const left = i % 2 === 0;
    // Up and inwards, a little spread around 60° from the ground.
    const angle = ((left ? 60 : 120) + (Math.random() - 0.5) * 40) * (Math.PI / 180);
    const speed = (0.55 + Math.random() * 0.45) * Math.sqrt(height) * 1.05;
    return {
      x: left ? -10 : width + 10,
      y: height * 0.95,
      vx: Math.cos(angle) * speed,
      vy: -Math.sin(angle) * speed,
      angle: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.35,
      w: 6 + Math.random() * 6,
      h: 4 + Math.random() * 4,
      color: COLORS[i % COLORS.length],
      wobble: Math.random() * Math.PI * 2,
    };
  });

  let frame = 0;
  const started = performance.now();
  const stop = () => {
    cancelAnimationFrame(frame);
    canvas.remove();
    playing = false;
  };
  // A hidden window draws no frames: this takes the canvas away all the same.
  const fallback = window.setTimeout(stop, DURATION_MS + 1_000);

  const draw = (now: number) => {
    const elapsed = now - started;
    if (!ctx || elapsed > DURATION_MS) {
      window.clearTimeout(fallback);
      stop();
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // Fades out over the last half second.
    ctx.globalAlpha = Math.min(1, (DURATION_MS - elapsed) / 500);
    for (const p of pieces) {
      p.vx *= DRAG;
      p.vy = p.vy * DRAG + GRAVITY;
      p.wobble += 0.1;
      p.x += p.vx + Math.sin(p.wobble) * 0.6;
      p.y += p.vy;
      p.angle += p.spin;
      if (p.y > height + 20) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      // Turning over: the piece narrows and widens as it falls.
      ctx.scale(1, Math.cos(p.wobble * 1.5));
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
}

/** For reduced motion: "🎉" and the label at the bottom of the window, not moving, for a moment. */
function stillNote(label: string) {
  const note = document.createElement("div");
  note.setAttribute("role", "status");
  note.className =
    "fixed bottom-6 left-1/2 z-[2147483000] -translate-x-1/2 rounded-md border border-border bg-bg px-4 py-2 text-sm text-fg shadow-lg";
  note.textContent = `🎉 ${label}`;
  document.body.appendChild(note);
  window.setTimeout(() => note.remove(), DURATION_MS);
}

/** Tells screen readers what the confetti is about. */
function announce(label: string) {
  const live = document.createElement("div");
  live.setAttribute("role", "status");
  live.className = "sr-only";
  document.body.appendChild(live);
  // Filled in after it is in the page, so it is read out.
  window.setTimeout(() => (live.textContent = label), 50);
  window.setTimeout(() => live.remove(), DURATION_MS + 1_000);
}
