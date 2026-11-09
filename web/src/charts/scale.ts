// Pure geometry and number helpers shared by the charts. Ported from the mockup
// (docs/superpowers/specs/2026-10-30-orca-mockups.html): niceTicks and barPath
// are kept as they are there.

import { MINUS } from "../lib/format";

/**
 * Axis tick values covering [lo, hi] in at most about n steps of 1, 2, 2.5, 5 or
 * 10 × a power of ten. Tick values are the step's multiples, so a display formatter
 * should round them (0.1 × 3 is 0.30000000000000004).
 */
export function niceTicks(lo: number, hi: number, n: number): number[] {
  if (lo === hi) hi = lo + 1;
  const span = hi - lo;
  const raw = span / Math.max(1, n);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => span / s <= n) || 10 * mag;
  const t0 = Math.floor(lo / step) * step;
  const t1 = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = t0; v <= t1 + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/**
 * Outline of a vertical bar from the baseline y `yb` to its tip `ye` (screen
 * coordinates: y grows downwards). With `round`, the two corners at the tip get a
 * radius of up to 4 px; the corners on the baseline stay square. "" for a bar under
 * half a pixel tall.
 */
export function barPath(x: number, w: number, yb: number, ye: number, round: boolean): string {
  const h = Math.abs(ye - yb);
  const r = round ? Math.min(4, w / 2, h) : 0;
  if (h < 0.5) return "";
  if (ye < yb) return `M${x},${yb}V${ye + r}Q${x},${ye} ${x + r},${ye}H${x + w - r}Q${x + w},${ye} ${x + w},${ye + r}V${yb}Z`;
  return `M${x},${yb}V${ye - r}Q${x},${ye} ${x + r},${ye}H${x + w - r}Q${x + w},${ye} ${x + w},${ye - r}V${yb}Z`;
}

/**
 * A polyline through the points; a null starts a new subpath, so a gap is never
 * bridged. A run of one point gets a zero-length segment so its round cap still
 * draws a dot.
 */
export function linePath(points: ReadonlyArray<readonly [number, number] | null>): string {
  let d = "";
  let run = 0;
  const endRun = () => {
    if (run === 1) d += "h0";
    run = 0;
  };
  for (const p of points) {
    if (!p) {
      endRun();
      continue;
    }
    d += (run === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1);
    run++;
  }
  endRun();
  return d;
}

/**
 * A trade marker's triangle (the fund page's price chart draws the same): a buy points up and
 * sits just above the price (x, y), a sale points down and sits just below it, so the marker
 * never covers the line it marks. `half` is half the base width.
 */
export function markerPath(x: number, y: number, up: boolean, half = 5.5): string {
  const tip = y + (up ? -1 : 1) * (half + 2);
  const run = half;
  const rise = (up ? 1 : -1) * half * 1.7;
  return `M${x.toFixed(1)},${tip.toFixed(1)}l${run},${rise.toFixed(1)}h${-2 * half}z`;
}

/** Short count for axis labels and tooltips: 12345678 → "12.35M", 850000 → "850K". */
export function compact(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? MINUS : "";
  for (const [unit, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    // Round first, so 999,999 reads "1M" and never "1000K".
    const x = +(a / unit).toFixed(2);
    if (x >= 1) return sign + x + suffix;
  }
  return sign + +a.toFixed(2);
}
