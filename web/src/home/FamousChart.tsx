// The home page's Famous funds chart (spec docs/superpowers/specs/2026-11-20-home-famous-chart-design.md, 5-8):
// one row per fund, best return first, bars from a zero line, the S&P 500 as a dotted line, and a 15-row
// (phone 10) scrolling window whose scale fits the funds in view and glides with the scroll.
// HTML rows rather than SVG: each row is a link to the fund, and the bars are placed in % of the plot.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Link } from "react-router";
import { useTooltip, type TipContent, type TooltipApi } from "../charts/Tooltip";
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
} from "./famousChart";
import { useEasedScroll } from "./useEasedScroll";
import "./famousChart.css";

/** Best return first; ties by fund id so the order never flickers. */
export const bestFirst = (a: TopRow, b: TopRow): number => b.ann_return - a.ann_return || a.fund_id - b.fund_id;

/** The layout of each mode: rows in the window, row height, the plot's right inset (room for the end label),
 * the label room kept left of a loss (7.3), Page Up/Down rows, the fixed columns before the plot, the label gap. */
const DESKTOP = { vis: 15, row: 46, inset: 56, room: 50, page: 14, cols: 32 + 14 + 252 + 14, gap: 6 };
const PHONE = { vis: 10, row: 48, inset: 50, room: 48, page: 9, cols: 28 + 8 + 136 + 8, gap: 5 };
/** Below this width (px) the module lays out for a phone. */
export const PHONE_BELOW = 560;
/** The width assumed when it cannot be measured (jsdom): a desktop page. */
export const FALLBACK_W = 1184;

const f3 = (x: number) => `${+(x * 100).toFixed(3)}%`;

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
  const M = phone ? PHONE : DESKTOP;
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

  // Position in rows from the top (fractional while gliding).
  const [p, setP] = useState(0);
  const es = useEasedScroll(box, M.row, setP);

  // A new list or period starts at the top with nothing gliding.
  const shownFor = useRef(`${name}|${period}`);
  useLayoutEffect(() => {
    const key = `${name}|${period}`;
    if (shownFor.current === key) return;
    shownFor.current = key;
    es.stop();
    if (box.current) box.current.scrollTop = 0;
    setP(0);
  }, [name, period, es]);
  useEffect(() => () => tip.hide(), [tip]);

  // The grow-in replays by swapping between two identical animations (g0 / g1) when `run` changes.
  const [grow, setGrow] = useState({ run, odd: false });
  if (grow.run !== run) setGrow({ run, odd: !grow.odd });

  const pc = scrolls ? Math.max(0, Math.min(n - M.vis, p)) : 0;
  const view = Math.round(pc);
  const dom = domainAt(track, pc);
  const span = dom.hi - dom.lo;
  const at = (v: number) => (Math.max(dom.lo, Math.min(dom.hi, v)) - dom.lo) / span;
  const zero = at(0);
  const on = new Set(ticksFor(dom, phone));
  const step = stepFor(Math.min(n, M.vis));
  const first = view + 1;
  const last = Math.min(n, view + M.vis);

  const tipFor = (m: Model, fill: string): TipContent => ({
    title: m.r.name,
    rows: [
      { color: fill, label: "Return a year", value: retLabel(m.r.ann_return) },
      ...(spx == null ? [] : [{ label: "vs S&P 500", value: vsLabel(m.r.ann_return, spx) }]),
      { label: "AUM", value: aumLabel(m.r.book) },
    ],
  });
  /** Above the row at the plot's start; below it for the first two rows in view, clear of the axis. */
  const showTip = (api: TooltipApi, el: HTMLElement, content: TipContent, below: boolean) => {
    const b = el.getBoundingClientRect();
    const x = b.left + M.cols - 14; // the tooltip adds its own 14px
    if (below) api.show(content, x, b.bottom - 10, { place: "cursor" });
    else api.show(content, x, b.top + 8, { place: "above" });
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!scrolls || e.altKey || e.ctrlKey || e.metaKey) return;
    const cur = Math.round(es.target() / M.row);
    const to = { ArrowDown: cur + 1, ArrowUp: cur - 1, PageDown: cur + M.page, PageUp: cur - M.page, Home: 0, End: n - M.vis }[
      e.key
    ];
    if (to === undefined) return;
    e.preventDefault();
    es.glide(Math.max(0, Math.min(n - M.vis, to)) * M.row);
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
      className={"fc" + (phone ? " phone" : "") + (scrolls ? " scrolls" : "") + (grow.odd ? " g1" : " g0")}
    >
      <div className="fc-axis cols" aria-hidden="true" style={bar ? { paddingRight: bar } : undefined}>
        <span />
        <span className="fc-axl">{phone ? "Return a year" : ""}</span>
        <div className="plot">
          <div className="in">
            {candidates.map((t) => (
              <span
                key={t}
                className="tick"
                style={{ left: f3(Math.max(-0.08, Math.min(1.08, (t - dom.lo) / span))), opacity: on.has(t) ? 1 : 0 }}
              >
                {axisPct(t)}
              </span>
            ))}
            {spx != null && (
              <>
                <span className="spx" style={{ left: f3(at(spx * 100)) }}>
                  {phone ? "S&P " : "S&P 500 "}
                  {retLabel(spx)}
                </span>
                <span className="spx-m" style={{ left: f3(at(spx * 100)) }} />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="fc-wrap">
        <span className={"fade t" + (scrolls && pc > 0.01 ? " on" : "")} aria-hidden="true" />
        <div className="fc-win" ref={box} {...winProps}>
          <div className="fc-list">
            <div className="fc-grid cols" aria-hidden="true">
              <span />
              <span />
              <div className="plot">
                <div className="in">
                  <span className="zl" style={{ left: f3(zero) }} />
                  {spx != null && <span className="spl" style={{ left: f3(at(spx * 100)) }} />}
                </div>
              </div>
            </div>
            {model.map((m, i) => {
              const ret = m.r.ann_return;
              const v = ret * 100;
              const gain = ret >= 0;
              const end = at(v);
              const left = gain ? zero : end;
              const fill = shadeFor(ret, dark);
              const cut = v > dom.hi + 1e-9 || v < dom.lo - 1e-9;
              const below = i - view < 2;
              const shown = phone ? phoneNameOf(m.short) : m.short;
              return (
                <Link
                  key={m.r.fund_id}
                  className="fc-row cols"
                  to={`/fund/${m.r.fund_id}`}
                  aria-label={rowLabel({ i: i + 1, n, name: m.short, manager: m.manager, book: m.r.book, ret, spx })}
                  style={{ ["--dl" as string]: `${Math.min(i, M.vis - 1) * step}ms` }}
                  onPointerEnter={(e: PointerEvent<HTMLAnchorElement>) => {
                    if (!phone && e.pointerType !== "touch") showTip(tip, e.currentTarget, tipFor(m, fill), below);
                  }}
                  onPointerLeave={() => tip.hide()}
                  onFocus={(e) => {
                    if (!phone) showTip(tip, e.currentTarget, tipFor(m, fill), below);
                  }}
                  onBlur={() => tip.hide()}
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
                  <span className="plot" aria-hidden="true">
                    <span className="in">
                      <span
                        className={"bar " + (gain ? "gain" : "loss") + (cut ? " cut" : "")}
                        style={{ left: f3(left), width: f3(gain ? end - zero : zero - end), background: fill }}
                      />
                      <span
                        className={"lab" + (i === 0 ? " lead" : "")}
                        style={
                          gain
                            ? { left: `calc(${f3(end)} + ${M.gap}px)`, right: "auto" }
                            : { left: "auto", right: `calc(${f3(1 - left)} + ${M.gap}px)` }
                        }
                      >
                        {retLabel(ret)}
                      </span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
        <span className={"fade b" + (scrolls && pc < n - M.vis - 0.01 ? " on" : "")} aria-hidden="true" />
      </div>
      <p className="fc-cap" aria-live="polite">
        {captionText(first, last, n, scrolls)}
      </p>
    </div>
  );
}
