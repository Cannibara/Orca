// The home page's Famous funds chart (spec docs/superpowers/specs/2026-11-20-home-famous-chart-design.md, 5-8):
// one row per fund, best return first, bars from a zero line, the S&P 500 as a dotted line, and a 15-row
// (phone 10) scrolling window whose scale fits the funds in view and glides with the scroll.
// HTML rows rather than SVG: each row is a link to the fund, and the bars are placed in % of the plot.
//
// Speed: the scale moves on every frame of a scroll, so React renders only when the whole-row position
// changes (caption, region name). The rows are memoised and never take the scale; bar, label, tick and line
// positions are written straight to the DOM by `paint`, which skips the frame when the scale has not moved.
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Link } from "react-router";
import { useTooltip, type TipContent } from "../charts/Tooltip";
import type { TopRow } from "../data/types";
import { axisPct } from "../fund/fmt";
import { stepFor } from "../fund/geometry";
import { useWidth } from "../fund/hooks";
import { managerLine, phoneNameOf, shortNameOf } from "../lib/famousNames";
import { photoOf } from "../lib/people";
import { currentTheme } from "../lib/theme";
import {
  aumLabel,
  captionText,
  domainAt,
  initials,
  retLabel,
  rowLabel,
  shadeFor,
  ticksFor,
  vsLabel,
  windowDomains,
  type Track,
} from "./famousChart";
import { useEasedScroll } from "./useEasedScroll";
import "./famousChart.css";

/** Best return first; ties by fund id so the order never flickers. */
export const bestFirst = (a: TopRow, b: TopRow): number => b.ann_return - a.ann_return || a.fund_id - b.fund_id;

/** The layout of each mode: rows in the window, row height, the plot's right inset (room for the end label),
 * the label room kept left of a loss (7.3), Page Up/Down rows, the fixed columns before the plot, the label gap. */
const DESKTOP = { vis: 15, row: 46, inset: 56, room: 50, page: 14, cols: 32 + 14 + 252 + 14, gap: 6 };
const PHONE = { vis: 10, row: 48, inset: 50, room: 48, page: 9, cols: 28 + 8 + 136 + 8, gap: 5 };
type Mode = typeof DESKTOP;
/** ms the grow-in takes at most (8): the last row starts at 450ms and its label fades in 450ms after that over
 * 300ms, so 1200ms, plus a margin. After it the animations are taken off, which makes each frame's restyle cheaper. */
const GROW_MS = 1400;
/** ms without a change before a screen reader hears the caption: a glide passes many rows. */
const SETTLE_MS = 300;
/** Below this width (px) the module lays out for a phone. */
export const PHONE_BELOW = 560;
/** The width assumed when it cannot be measured (jsdom): a desktop page. */
export const FALLBACK_W = 1184;

const f3 = (x: number) => `${+(x * 100).toFixed(3)}%`;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Dark mode as the page has it now: the theme switch (data-theme) or the device's setting. */
function useDark(): boolean {
  const [dark, setDark] = useState(() => currentTheme() === "dark");
  useEffect(() => {
    const read = () => setDark(currentTheme() === "dark");
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(read) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener?.("change", read);
    return () => {
      mo?.disconnect();
      mq?.removeEventListener?.("change", read);
    };
  }, []);
  return dark;
}

/** `value` once it has stopped changing for `ms` (what a polite live region should announce). */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** The person's photo, grey until the row is hovered; their initials (or the fund's) on a disc without one. */
function Photo({ manager, who }: { manager: string | null | undefined; who: string }) {
  const [failed, setFailed] = useState(false);
  const src = photoOf(manager);
  if (!src || failed)
    return (
      <span className="fc-face init" aria-hidden="true">
        {initials(who)}
      </span>
    );
  return <img className="fc-face" src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

type Model = { r: TopRow; short: string; manager: string | null };

/** One fund's row. It takes nothing that changes while scrolling, so a glide never re-renders it. */
const Row = memo(function Row({
  m,
  i,
  n,
  spx,
  phone,
  fill,
  delay,
  onTip,
  offTip,
}: {
  m: Model;
  i: number;
  n: number;
  spx: number | null;
  phone: boolean;
  fill: string;
  /** The grow-in delay (8). */
  delay: string;
  onTip: (i: number, el: HTMLElement, touch: boolean) => void;
  offTip: () => void;
}) {
  const ret = m.r.ann_return;
  const gain = ret >= 0;
  const shown = phone ? phoneNameOf(m.short) : m.short;
  return (
    <Link
      className="fc-row cols"
      to={`/fund/${m.r.fund_id}`}
      // the name as shown (a phone's shorter one), so the spoken label contains the visible one (WCAG 2.5.3)
      aria-label={rowLabel({ i: i + 1, n, name: shown, manager: m.manager, book: m.r.book, ret, spx })}
      style={{ ["--dl" as string]: delay }}
      onPointerEnter={(e: PointerEvent<HTMLAnchorElement>) => onTip(i, e.currentTarget, e.pointerType === "touch")}
      onPointerLeave={offTip}
      onFocus={(e) => onTip(i, e.currentTarget, false)}
      onBlur={offTip}
    >
      <Photo manager={m.r.manager} who={m.manager ?? m.short} />
      <span className="who" aria-hidden="true">
        {phone ? (
          <>
            <span className="nm">{shown}</span>
            <span className="l2">
              <span className="am">{aumLabel(m.r.book)}</span>
              {m.manager && (
                <>
                  <span className="sep" />
                  <span className="mg">{m.manager}</span>
                </>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="l1">
              <span className="nm">{shown}</span>
              <span className="sep" />
              <span className="am">{aumLabel(m.r.book)}</span>
            </span>
            {m.manager && <span className="mg">{m.manager}</span>}
          </>
        )}
      </span>
      {/* left/width (and the label's left/right) come from `paint`, never from here */}
      <span className="plot" aria-hidden="true">
        <span className="in">
          <span className={"bar " + (gain ? "gain" : "loss")} style={{ background: fill }} />
          <span className={"lab" + (i === 0 ? " lead" : "")}>{retLabel(ret)}</span>
        </span>
      </span>
    </Link>
  );
});

// ---- the per-frame painter ----

/** A DOM element and the style values last written to it, so an unchanged value is not written again; a row's
 * bar also keeps the scale it was last placed on (`lo`/`hi`) and whether it is drawn broken. */
type Slot = {
  el: HTMLElement;
  s: Partial<Record<"left" | "width" | "right" | "opacity", string>>;
  cut?: boolean;
  lo?: number;
  hi?: number;
};
const slot = (el: HTMLElement): Slot => ({ el, s: {} });
function put(x: Slot | null, k: "left" | "width" | "right" | "opacity", v: string) {
  if (!x || x.s[k] === v) return;
  x.s[k] = v;
  x.el.style[k] = v;
}

/** What `paint` reads: the scale's inputs (set after each render that changes them) and the elements it moves. */
type Scene = {
  track: Track;
  /** Returns in points, best first, one per row. */
  vals: number[];
  vis: number;
  scrolls: boolean;
  phone: boolean;
  innerW: number;
  gap: number;
  spx: number | null;
  ticks: { t: number; x: Slot | null }[];
  bars: Slot[];
  labs: Slot[];
  lines: { zl: Slot | null; spl: Slot | null; spx: Slot | null; spxm: Slot | null };
  fades: [HTMLElement | null, HTMLElement | null];
  /** The scale last painted (NaN: paint everything). */
  lo: number;
  hi: number;
};

/** Rows painted on each side of the window while scrolling: a fast fling or the compositor's own scroll can
 * bring a row or two into view before the next frame's paint. */
const NEAR = 3;

/**
 * Places everything that follows the scale at fractional row position p. With `all` every row is placed;
 * otherwise only the rows in or near the window (the rest are placed when they come near), and nothing at
 * all is written while the scale and the rows near the window are where they were.
 */
function paint(sc: Scene, p: number, all = false) {
  const n = sc.vals.length;
  const pc = sc.scrolls ? clamp(p, 0, n - sc.vis) : 0;
  sc.fades[0]?.classList.toggle("on", sc.scrolls && pc > 0.01);
  sc.fades[1]?.classList.toggle("on", sc.scrolls && pc < n - sc.vis - 0.01);
  const dom = domainAt(sc.track, pc);
  const span = dom.hi - dom.lo;
  const at = (v: number) => (clamp(v, dom.lo, dom.hi) - dom.lo) / span;
  const zero = at(0);
  if (all || dom.lo !== sc.lo || dom.hi !== sc.hi) {
    sc.lo = dom.lo;
    sc.hi = dom.hi;
    put(sc.lines.zl, "left", f3(zero));
    if (sc.spx != null) {
      const s = f3(at(sc.spx * 100));
      put(sc.lines.spl, "left", s);
      put(sc.lines.spx, "left", s);
      put(sc.lines.spxm, "left", s);
    }
    // Ticks: the ones on show, and any still fading near the edges; one beyond 8% of either edge is parked
    // there (the axis clips it) and, being cached, costs no write while it stays parked.
    const on = new Set(ticksFor(dom, sc.phone, sc.innerW));
    for (const { t, x } of sc.ticks) {
      put(x, "left", f3(clamp((t - dom.lo) / span, -0.08, 1.08)));
      put(x, "opacity", on.has(t) ? "1" : "0");
    }
  }
  const g = sc.gap;
  const from = all ? 0 : Math.max(0, Math.floor(pc) - NEAR);
  const to = all ? n : Math.min(n, Math.floor(pc) + sc.vis + 1 + NEAR);
  for (let i = from; i < to; i++) {
    const bar = sc.bars[i];
    const lab = sc.labs[i];
    if (!bar || !lab || (bar.lo === dom.lo && bar.hi === dom.hi)) continue;
    bar.lo = dom.lo;
    bar.hi = dom.hi;
    const v = sc.vals[i];
    const gain = v >= 0;
    const end = at(v);
    const left = gain ? zero : end;
    put(bar, "left", f3(left));
    put(bar, "width", f3(gain ? end - zero : zero - end));
    // a bar past the scale's edge (mid-scroll only) is drawn broken there
    const cut = v > dom.hi + 1e-9 || v < dom.lo - 1e-9;
    if (bar.cut !== cut) {
      bar.cut = cut;
      bar.el.classList.toggle("cut", cut);
    }
    if (gain) {
      put(lab, "left", `calc(${f3(end)} + ${g}px)`);
      put(lab, "right", "auto");
    } else {
      put(lab, "left", "auto");
      put(lab, "right", `calc(${f3(1 - left)} + ${g}px)`);
    }
  }
}

export function FamousChart({
  name,
  rows,
  spx,
  period,
  run,
}: {
  /** The list's name (a new list starts at the top). */
  name: string;
  rows: TopRow[];
  /** S&P 500 return a year over the same window; null draws no S&P line. */
  spx: number | null;
  period: string;
  /** Bumped by the page on a list switch, a period switch and Table → Chart: the bars grow in again. */
  run: number;
}) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(root, 280, FALLBACK_W);
  const phone = width < PHONE_BELOW;
  const M: Mode = phone ? PHONE : DESKTOP;
  const dark = useDark();
  const tip = useTooltip();

  const model = useMemo<Model[]>(
    () =>
      [...rows].sort(bestFirst).map((r) => {
        const short = shortNameOf(r.fund_id, r.name);
        return { r, short, manager: managerLine(r.manager, short) };
      }),
    [rows],
  );
  const n = model.length;
  const scrolls = n > M.vis;
  // The window's scrollbar takes width from the rows (not where scrollbars overlay): the axis gives up as
  // much on its right, so the two scales line up.
  const [bar, setBar] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    const w = el && scrolls ? el.offsetWidth - el.clientWidth : 0;
    setBar(Math.max(0, w));
  }, [scrolls, width]);
  const innerW = Math.max(1, width - M.cols - M.inset - bar);
  const track = useMemo(
    () => windowDomains(model.map((m) => m.r.ann_return), M.vis, spx, innerW, M.room),
    [model, M.vis, M.room, spx, innerW],
  );
  // Every tick value the scale can show, each kept as one element so it fades in and out instead of popping.
  const candidates = useMemo(() => {
    const ends = [...track.raw, ...track.smooth];
    const lo = Math.min(...ends.map((d) => d.lo)) - 10;
    const hi = Math.max(...ends.map((d) => d.hi)) + 10;
    const out: number[] = [];
    for (let t = Math.ceil(lo / 5) * 5; t <= hi; t += 5) out.push(t + 0);
    return out;
  }, [track]);

  // Position in rows from the top (fractional while gliding): kept out of React, painted straight to the DOM.
  const pos = useRef(0);
  const scene = useRef<Scene | null>(null);
  // React state is only the whole row at the top of the window.
  const [view, setView] = useState(0);
  const onPos = useCallback((p: number) => {
    pos.current = p;
    const sc = scene.current;
    if (!sc) return;
    paint(sc, p);
    const n = sc.vals.length;
    setView(sc.scrolls ? Math.round(clamp(p, 0, n - sc.vis)) : 0);
  }, []);
  const es = useEasedScroll(box, M.row, onPos);

  // A new list or period starts at the top with nothing gliding.
  const shownFor = useRef(`${name}|${period}`);
  useLayoutEffect(() => {
    const key = `${name}|${period}`;
    if (shownFor.current === key) return;
    shownFor.current = key;
    es.stop();
    if (box.current) box.current.scrollTop = 0;
    pos.current = 0;
    setView(0);
    if (scene.current) paint(scene.current, 0);
  }, [name, period, es]);
  useEffect(() => () => tip.hide(), [tip]);

  // After a render that can change the scale or the elements it moves: find them again and paint them all.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const q = (s: string) => el.querySelector<HTMLElement>(s);
    const one = (s: string) => {
      const e = q(s);
      return e ? slot(e) : null;
    };
    const tickEls = el.querySelectorAll<HTMLElement>(".fc-axis .tick");
    scene.current = {
      track,
      vals: model.map((m) => m.r.ann_return * 100),
      vis: M.vis,
      scrolls,
      phone,
      innerW,
      gap: M.gap,
      spx,
      ticks: candidates.map((t, i) => ({ t, x: tickEls[i] ? slot(tickEls[i]) : null })),
      bars: [...el.querySelectorAll<HTMLElement>(".fc-row .bar")].map(slot),
      labs: [...el.querySelectorAll<HTMLElement>(".fc-row .lab")].map(slot),
      lines: { zl: one(".fc-grid .zl"), spl: one(".fc-grid .spl"), spx: one(".fc-axis .spx"), spxm: one(".fc-axis .spx-m") },
      fades: [q(".fade.t"), q(".fade.b")],
      lo: NaN,
      hi: NaN,
    };
    paint(scene.current, pos.current, true);
  }, [model, track, candidates, spx, phone, innerW, scrolls, M]);

  // The grow-in replays by swapping between two identical animations (g0 / g1) when `run` changes; once it
  // has played, neither class is set.
  const [grow, setGrow] = useState({ run, odd: false, on: true });
  if (grow.run !== run) setGrow({ run, odd: !grow.odd, on: true });
  useEffect(() => {
    if (!grow.on) return;
    const id = setTimeout(() => setGrow((g) => ({ ...g, on: false })), GROW_MS);
    return () => clearTimeout(id);
  }, [grow.on, grow.run]);

  const top = scrolls ? clamp(view, 0, n - M.vis) : 0;
  const first = top + 1;
  const last = Math.min(n, top + M.vis);
  const caption = captionText(first, last, n, scrolls);
  const said = useSettled(caption, SETTLE_MS);

  // The rows' tooltip handlers stay the same function for the chart's life (so the memoised rows keep), and
  // read what they need at the moment of hovering.
  const live = useRef({ model, spx, dark, phone, M, top, tip });
  live.current = { model, spx, dark, phone, M, top, tip };
  const onTip = useCallback((i: number, el: HTMLElement, touch: boolean) => {
    const { model, spx, dark, phone, M, top, tip } = live.current;
    const m = model[i];
    if (phone || touch || !m) return;
    const content: TipContent = {
      title: m.r.name,
      rows: [
        { color: shadeFor(m.r.ann_return, dark), label: "Return a year", value: retLabel(m.r.ann_return) },
        ...(spx == null ? [] : [{ label: "vs S&P 500", value: vsLabel(m.r.ann_return, spx) }]),
        { label: "AUM", value: aumLabel(m.r.book) },
      ],
    };
    // Above the row at the plot's start; below it for the first two rows in view, clear of the axis.
    const b = el.getBoundingClientRect();
    const x = b.left + M.cols - 14; // the tooltip adds its own 14px
    if (i - top < 2) tip.show(content, x, b.bottom - 10, { place: "cursor" });
    else tip.show(content, x, b.top + 8, { place: "above" });
  }, []);
  const offTip = useCallback(() => live.current.tip.hide(), []);

  const step = stepFor(Math.min(n, M.vis));
  // Kept as the same elements between renders, so a render for a new row in view does not touch them.
  const rowEls = useMemo(
    () =>
      model.map((m, i) => (
        <Row
          key={m.r.fund_id}
          m={m}
          i={i}
          n={n}
          spx={spx}
          phone={phone}
          fill={shadeFor(m.r.ann_return, dark)}
          delay={`${Math.min(i, M.vis - 1) * step}ms`}
          onTip={onTip}
          offTip={offTip}
        />
      )),
    [model, n, spx, phone, dark, M.vis, step, onTip, offTip],
  );
  const tickEls = useMemo(
    () =>
      candidates.map((t) => (
        <span key={t} className="tick">
          {axisPct(t)}
        </span>
      )),
    [candidates],
  );

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!scrolls || e.altKey || e.ctrlKey || e.metaKey) return;
    const cur = Math.round(es.target() / M.row);
    const to = { ArrowDown: cur + 1, ArrowUp: cur - 1, PageDown: cur + M.page, PageUp: cur - M.page, Home: 0, End: n - M.vis }[
      e.key
    ];
    if (to === undefined) return;
    e.preventDefault();
    es.glide(clamp(to, 0, n - M.vis) * M.row);
  };

  const winProps = scrolls
    ? {
        tabIndex: 0,
        role: "region",
        "aria-label": `Funds ${first} to ${last} of ${n}, scrollable`,
        style: { height: M.vis * M.row },
        onKeyDown: onKey,
        onScroll: () => tip.hide(),
      }
    : {};

  return (
    <div
      ref={root}
      className={"fc" + (phone ? " phone" : "") + (scrolls ? " scrolls" : "") + (grow.on ? (grow.odd ? " g1" : " g0") : "")}
    >
      <div className="fc-axis cols" aria-hidden="true" style={bar ? { paddingRight: bar } : undefined}>
        <span />
        {/* on a phone the standfirst is hidden, so the axis says the figures are estimates */}
        <span className="fc-axl">{phone ? "Est. return a year" : ""}</span>
        <div className="plot">
          <div className="in">
            {tickEls}
            {spx != null && (
              <>
                <span className="spx">
                  {phone ? "S&P " : "S&P 500 "}
                  {retLabel(spx)}
                </span>
                <span className="spx-m" />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="fc-wrap">
        <span className="fade t" aria-hidden="true" />
        <div className="fc-win" ref={box} {...winProps}>
          <div className="fc-list">
            <div className="fc-grid cols" aria-hidden="true">
              <span />
              <span />
              <div className="plot">
                <div className="in">
                  <span className="zl" />
                  {spx != null && <span className="spl" />}
                </div>
              </div>
            </div>
            {rowEls}
          </div>
        </div>
        <span className="fade b" aria-hidden="true" />
      </div>
      {/* the caption follows every row; a screen reader hears it once the window has settled */}
      <p className="fc-cap" aria-hidden="true">
        {caption}
      </p>
      <p className="vh fc-said" aria-live="polite">
        {said}
      </p>
    </div>
  );
}
