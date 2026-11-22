import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTooltip, type TipContent } from "../charts/Tooltip";
import type { Weekly } from "../data/types";
import { money, pct } from "../lib/format";
import { fmtLong, qShort } from "./fmt";
import { reducedMotion, useWidth } from "./hooks";
import { PeriodPicker } from "./PeriodPicker";
import { periodAsOf, priceAt, quarterClose, type PosRow, type Timeline } from "./positions";
import {
  OTHER_KEY,
  gradientCss,
  groupTiles,
  heldSince,
  holdingReturn,
  inkFor,
  layout,
  parseColor,
  priceChange,
  returnColor,
  share,
  type LabelFont,
  type Measure,
  type RGB,
  type Scale,
  type Tile,
} from "./treemap";
import { DUR, createTreemapView, type TileDatum, type TreemapView } from "./treemapView";
import { useWeeklyPrices, type HoldingsState, type PositionData } from "./usePositionData";
import "./holdings.css";

// The Holdings panel: the period picker that drives the whole tab, then a tree map of what the fund held at the
// end of the period. A tile's area is the holding's value (the Positions table's figures, so the two agree) and
// its colour the fund's return on it over the period. The colour needs each stock's weekly price file, so nothing
// is drawn until every tile's is in: the tiles then form (or move) already in their final red or green, and the
// colours are never animated. While the files load, the last drawing stays under a quiet note.

/** The return the scale reaches its full colour at: ±25% for a quarter, ±50% for 12 months. */
const CLAMP_Q = 0.25;
const CLAMP_Y = 0.5;

type Colours = { scale: Scale; ink: RGB; surface: RGB; band: RGB };

/** The tree map's tokens as they are now (both themes define them; the defaults are the light theme's). */
function readColours(): Colours {
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(document.documentElement) : null;
  const get = (name: string, fallback: string): RGB => parseColor(cs?.getPropertyValue(name) ?? "") ?? (parseColor(fallback) as RGB);
  return {
    scale: {
      gain: get("--tm-gain", "#00875F"),
      gainLo: get("--tm-gain-lo", "#C4ECDC"),
      loss: get("--tm-loss", "#D60F25"),
      lossLo: get("--tm-loss-lo", "#FBCDD1"),
    },
    ink: get("--ink", "#1B1916"),
    surface: get("--surface", "#FFFCF8"),
    band: get("--band", "#F0E6D8"),
  };
}

/** Bumps when the page switches theme (the switch, or the device's setting), so the colours are read again. */
function useThemeKey(): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const bump = () => setKey((k) => k + 1);
    const mo = typeof MutationObserver !== "undefined" ? new MutationObserver(bump) : null;
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    mq?.addEventListener?.("change", bump);
    return () => {
      mo?.disconnect();
      mq?.removeEventListener?.("change", bump);
    };
  }, []);
  return key;
}

const SIZES: Record<LabelFont, number> = { tk: 13, oth: 13, w: 12, n: 11.5 };

/**
 * Text widths in the label fonts, from a canvas once the page's fonts are known; a character-count estimate
 * where there is no canvas to ask (jsdom).
 */
function makeMeasure(root: () => HTMLElement | null): Measure & { clear(): void } {
  const cache = new Map<string, number>();
  let ctx: CanvasRenderingContext2D | null | undefined;
  const fonts = () => {
    const cs = root() ? getComputedStyle(root() as HTMLElement) : null;
    const mono = cs?.getPropertyValue("--f-mono").trim() || "monospace";
    const sans = cs?.getPropertyValue("--f-sans").trim() || "sans-serif";
    return { tk: `600 13px ${mono}`, oth: `600 13px ${sans}`, w: `500 12px ${sans}`, n: `400 11.5px ${sans}` } as Record<LabelFont, string>;
  };
  let f: Record<LabelFont, string> | null = null;
  const m = ((font: LabelFont, s: string) => {
    const k = font + "|" + s;
    let w = cache.get(k);
    if (w === undefined) {
      if (ctx === undefined) ctx = "fonts" in document ? document.createElement("canvas").getContext("2d") : null;
      if (ctx) {
        f ??= fonts();
        ctx.font = f[font];
        w = ctx.measureText(s).width * (font === "tk" ? 0.99 : 1) + 1;
      } else w = s.length * SIZES[font] * (font === "tk" ? 0.62 : 0.56);
      cache.set(k, w);
    }
    return w;
  }) as Measure & { clear(): void };
  m.clear = () => {
    cache.clear();
    f = null;
  };
  return m;
}

/** The close of a stock at the end of quarter q, as the market had it (no fallback to the fund's trade price). */
function closeAt(id: number, q: number, tl: Timeline, prices: Map<number, number>, w: Weekly | null | undefined): number | null {
  if (q >= tl.latest) return prices.get(id) ?? null;
  return w ? quarterClose(w, q) : null;
}

type Info = { ret: number | null; chg: number | null; since: number | null };

type Props = {
  h: HoldingsState;
  data: PositionData;
  /** Latest close of every stock that has one: the newest quarter's prices. */
  prices: Map<number, number>;
};

export function HoldingsPanel({ h, data, prices }: Props) {
  const { tl, period, setPeriod, store } = h;
  const tip = useTooltip();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const hatchId = "tmh" + uid;
  const panelRef = useRef<HTMLElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const layerRef = useRef<SVGGElement>(null);
  const view = useRef<TreemapView | null>(null);
  const panelW = useWidth(panelRef, 280, 900);
  const W = useWidth(boxRef, 200, 600);
  const H = panelW < 600 ? 340 : 440;
  const themeKey = useThemeKey();
  const colours = useMemo(readColours, [themeKey]);
  const [fontsKey, setFontsKey] = useState(0);
  const measure = useMemo(() => makeMeasure(() => panelRef.current), []);

  // The web fonts change every label's width: measure again once they are in.
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (!live) return;
      measure.clear();
      setFontsKey((k) => k + 1);
    });
    return () => {
      live = false;
    };
  }, [measure]);

  // ---- what is drawn: the rows of the period the table shows, grouped into tiles ----
  const shown = data.shown;
  const qs = shown?.qs ?? 0;
  const qe = shown?.qe ?? 0;
  const year = shown !== null && qe - qs === 3;
  const grouped = useMemo(() => {
    const held = (data.rows ?? []).filter((r) => r.open && r.val !== null && r.val > 0);
    return { ...groupTiles(held, (r) => r.val as number, (r) => String(r.id)), n: held.length };
  }, [data.rows]);
  const ids = useMemo(() => grouped.tiles.flatMap((t) => (t.item ? [t.item.id] : [])), [grouped]);
  // the start-of-period closes behind each tile's colour (the newest quarter's table needs none, its colours do)
  const wk = useWeeklyPrices(store, ids);

  const infos = useMemo(() => {
    const out = new Map<number, Info>();
    if (!shown) return out;
    for (const t of grouped.tiles) {
      const r = t.item;
      if (!r || !wk.weekly.has(r.id)) continue; // still loading
      const w = wk.weekly.get(r.id);
      const src = { tl, prices, weekly: wk.weekly };
      const startPx = priceAt(r.pos, qs - 1, src);
      out.set(r.id, {
        ret: holdingReturn(r.pos, qs, qe, startPx, r.px, tl),
        chg: priceChange(closeAt(r.id, qs - 1, tl, prices, w), closeAt(r.id, qe, tl, prices, w)),
        since: heldSince(r.pos.trades, qe),
      });
    }
    return out;
  }, [grouped, wk.weekly, shown, qs, qe, tl, prices]);

  const rects = useMemo(() => layout(grouped.tiles.map((t) => t.value), W, H), [grouped, W, H]);

  const endLabel = qe >= tl.latest ? fmtLong(tl.asof) : qShort(qe);
  const startLabel = qShort(qs - 1);
  const basis = year ? "12 months" : "quarter";

  const datums = useMemo<TileDatum[]>(() => {
    const clamp = year ? CLAMP_Y : CLAMP_Q;
    const tipFor = (t: Tile<PosRow>, info: Info | undefined, fill: RGB): TipContent => {
      if (!t.item) {
        const names = t.others.slice(0, 8).map((r) => r.ticker).join(", ");
        const more = t.others.length > 8 ? ` and ${t.others.length - 8} more` : "";
        return {
          title: "Other stocks",
          rows: [
            { label: "Value", value: money(t.value), big: true },
            { label: "Weight", value: share(t.weight) },
            { label: "Stocks", value: String(t.others.length) },
          ],
          note: `Each under 1% of the book: ${names}${more}.`,
        };
      }
      const r = t.item;
      const ret = info?.ret ?? null;
      const note = !info
        ? "Loading prices…"
        : ret !== null
          ? undefined
          : qs - 1 < tl.qmin
            ? `The data starts at ${qShort(tl.qmin)}: there is no ${startLabel} price to compare.`
            : `No price data for ${startLabel} → ${endLabel}.`;
      return {
        title: r.name ? `${r.ticker} · ${r.name}` : r.ticker,
        rows: [
          { label: "Value", value: money(r.val), big: true },
          { label: "Weight", value: share(t.weight) },
          { label: `Fund's return, ${basis}`, value: ret === null ? "–" : pct(ret), color: ret === null ? undefined : `rgb(${fill.map(Math.round).join(", ")})` },
          { label: `Share price, ${basis}`, value: info?.chg == null ? "–" : pct(info.chg) },
          { label: "Held since", value: info?.since == null ? "–" : qShort(info.since) },
        ],
        note,
      };
    };
    return grouped.tiles.map((t, i) => {
      const rect = rects[i];
      if (!t.item) {
        const { ink } = inkFor(colours.band, colours.ink, colours.surface);
        return {
          key: OTHER_KEY,
          rect,
          other: true,
          fill: null,
          hollow: false,
          ink,
          soft: true,
          label: { other: true, ticker: "", name: "", weight: t.weight, value: t.value, count: t.others.length, ret: null },
          aria: `Other stocks: ${t.others.length} holdings under 1% each, ${money(t.value)}, ${share(t.weight)} of the book`,
          tip: () => tipFor(t, undefined, colours.band),
        };
      }
      const r = t.item;
      const key = String(r.id);
      const info = infos.get(r.id);
      const hollow = info !== undefined && info.ret === null;
      // a tile without its prices is never drawn (see `ready`); the band colour only fills the gap in this list
      const fill: RGB = !info ? colours.band : info.ret === null ? colours.surface : returnColor(info.ret, clamp, colours.scale);
      const { ink, soft } = inkFor(fill, colours.ink, colours.surface);
      const ret = info?.ret ?? null;
      const said = !info ? "loading" : ret === null ? "not available" : `${pct(ret)} over ${year ? "12 months" : "the quarter"}`;
      return {
        key,
        rect,
        other: false,
        fill,
        hollow,
        ink,
        soft,
        label: { other: false, ticker: r.ticker, name: r.name, weight: t.weight, value: t.value, count: 0, ret },
        aria: `${r.ticker}${r.name ? ", " + r.name : ""}: ${money(r.val)}, ${share(t.weight)} of the book, fund's return ${said}`,
        tip: () => tipFor(t, info, fill),
      };
    });
    // fontsKey: the same tiles, measured again
  }, [grouped, rects, infos, colours, year, qs, tl.qmin, startLabel, endLabel, basis, fontsKey]);

  // ---- the drawing ----
  useLayoutEffect(() => {
    if (!svgRef.current || !layerRef.current) return;
    const v = createTreemapView(svgRef.current, layerRef.current, { hatch: `url(#${hatchId})`, measure, tip });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [hatchId, measure, tip]);

  // Every tile's colour is known: its weekly file is in (or it has none). Until then the last drawing stays.
  const ready = !wk.pending;
  /**
   * The first render reads the box at fallback sizes; the next one has the real ones. Drawing waits for them.
   * Within 1 px counts as the same: at a browser zoom the box is fractional (1149.6 px), clientWidth rounds it
   * (1150) and useWidth floors it (1149), and an exact match kept a cold load from ever drawing.
   */
  const sized = () => {
    const near = (measured: number, min: number, have: number) => measured <= 0 || Math.abs(Math.max(min, measured) - have) <= 1;
    return near(boxRef.current?.clientWidth ?? 0, 200, W) && near(panelRef.current?.clientWidth ?? 0, 280, panelW);
  };
  const drawn = useRef<{ W: number; H: number; theme: number; fonts: number } | null>(null);
  const landedAt = useRef<number | null>(null);
  const [landed, setLanded] = useState(false);
  useLayoutEffect(() => {
    const v = view.current;
    if (!v || !ready || !sized()) return;
    const p = drawn.current;
    const t = performance.now();
    const same = p !== null && p.W === W && p.H === H && p.theme === themeKey && p.fonts === fontsKey;
    // The first drawing of tiles grows them in, and a redraw that comes while that is still running (the fonts
    // arriving, the scrollbar changing the width) joins it instead of cutting it short. After that a new period
    // or new prices move the tiles; a resize, a new theme or new fonts redraw in place.
    const joining = landedAt.current !== null && t - landedAt.current < DUR + 150;
    const animate = !reducedMotion() && (landedAt.current === null || same || joining);
    drawn.current = { W, H, theme: themeKey, fonts: fontsKey };
    v.render(datums, animate);
    if (datums.length && landedAt.current === null) {
      landedAt.current = t;
      setLanded(true);
    }
    // (`sized` reads W and panelW, so they are listed)
  }, [datums, W, H, panelW, themeKey, fontsKey, ready]);

  const loading = data.pending || wk.pending;
  const asOf = periodAsOf(period, tl);
  const empty = data.rows !== null && grouped.tiles.length === 0;
  const clampText = year ? "50%" : "25%";
  const caption =
    shown && grouped.tiles.length
      ? `${money(grouped.total)} at ${qe >= tl.latest ? "prices of " + fmtLong(tl.asof) : "quarter-end prices"} across ${grouped.n} ${grouped.n === 1 ? "holding" : "holdings"}` +
        (grouped.nSmall ? ` · ${grouped.nSmall} under 1% grouped as Other stocks` : "")
      : "";

  return (
    <section className="panel" id="holdPanel" aria-labelledby="holdTitle" ref={panelRef}>
      <PeriodPicker state={period} onChange={setPeriod} tl={tl} title="Holdings" titleId="holdTitle" asOf={asOf} />
      <div className="tm-pb">
        <div className={"tm-box" + (loading ? " is-loading" : "")} ref={boxRef} style={{ height: H }}>
          <svg
            className="tm"
            ref={svgRef}
            role="group"
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            aria-busy={loading}
            aria-label={
              shown
                ? `Holdings at ${qShort(qe)}: each tile's area is the holding's value, its colour the fund's return on it over ${year ? "the 12 months" : "the quarter"}. Arrow keys move between tiles. The Positions table below lists the same figures.`
                : "Holdings"
            }
          >
            <defs>
              <pattern id={hatchId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <rect className="tm-hb" width="6" height="6" />
                <line className="tm-hl" x1="3" y1="0" x2="3" y2="6" />
              </pattern>
            </defs>
            <g ref={layerRef} />
          </svg>
          {(data.rows === null || (wk.pending && !landed)) && <p className="tm-msg">Loading prices…</p>}
          {empty && <p className="tm-msg">The fund held no priced stock at the end of this period.</p>}
          {loading && landed && (
            <div className="tm-load" aria-hidden="true">
              <span>Loading prices…</span>
            </div>
          )}
        </div>
      </div>
      <div className="strip legend tm-leg">
        <span className="tm-lt">{shown ? `Colour, and the % after each value: the fund's return on each holding, ${startLabel} → ${endLabel}` : "Colour, and the % after each value: the fund's return on each holding"}</span>
        <span className="tm-scale" aria-hidden="true">
          <span className="tm-grad" style={{ background: gradientCss(colours.scale) }} />
          <span className="tm-ticks">
            <span>{"−" + clampText}</span>
            <span>0%</span>
            <span>{"+" + clampText}</span>
          </span>
        </span>
        <span className="vh">{`, from a loss of ${clampText} or more in red, through grey at 0%, to a gain of ${clampText} or more in green.`}</span>
        <span className="tm-keys">
          <span className="lg">
            <i className="sw-new" aria-hidden="true" />
            No price data
          </span>
          <span className="lg">
            <i className="sw-oth" aria-hidden="true" />
            Other stocks
          </span>
        </span>
      </div>
      <p className="pf tm-cap">{caption}</p>
    </section>
  );
}
