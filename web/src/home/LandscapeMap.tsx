import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router";
import { useTooltip, type TipContent } from "../charts/Tooltip";
import type { Landscape } from "../data/types";
import { reducedMotion, useWidth } from "../fund/hooks";
import { gradientCss, inkFor, lerpLab, returnColor, rgbCss, share, type RGB } from "../fund/treemap";
import { makeMeasure, readColours, useThemeKey } from "../fund/treemapDom";
import { DUR, createTreemapView, type TileDatum, type TreemapView } from "../fund/treemapView";
import { count, pct } from "../lib/format";
import { aum, buildTree, fitHead, fitTile, layoutMap, pathTo, ROOT, type LNode, type LTile, type Period } from "./landscape";
import "../fund/holdings.css";
import "./landscape.css";

/** The annual return the colours reach their full depth at, either way. */
export const CLAMP = 0.25;
/** The map's height: a phone's is shorter (owner's holdings map: 340 / 440). */
const H_WIDE = 620;
const H_PHONE = 460;
const PHONE_BELOW = 600;

type Props = {
  file: Landscape;
  period: Period;
  /** The period as the switch names it ("3 years"), for the tooltips. */
  periodLabel: string;
  /** The type the map is zoomed into (ROOT: all filers). */
  zoom: string;
  onZoom: (type: string) => void;
};

/**
 * The Landscape tree map: every current 13F filer, grouped by type of investor under heading strips, each tile's
 * area its 13F book and its colour its estimated annual return over the period. A heading (or a group too small
 * to open) zooms in; a filer opens its fund page; the breadcrumb and Escape zoom out.
 */
export function LandscapeMap({ file, period, periodLabel, zoom, onZoom }: Props) {
  const navigate = useNavigate();
  const tip = useTooltip();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const hatchId = "lsh" + uid;
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const layerRef = useRef<SVGGElement>(null);
  const view = useRef<TreemapView | null>(null);
  const W = useWidth(boxRef, 200, 1100);
  const H = W < PHONE_BELOW ? H_PHONE : H_WIDE;
  const themeKey = useThemeKey();
  const colours = useMemo(readColours, [themeKey]);
  const [fontsKey, setFontsKey] = useState(0);
  const measure = useMemo(() => makeMeasure(() => wrapRef.current), []);
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

  const tree = useMemo(() => buildTree(file, period), [file, period]);
  const path = useMemo(() => pathTo(tree, zoom), [tree, zoom]);
  const root = path[path.length - 1];
  const tiles = useMemo(() => layoutMap(root, W, H), [root, W, H]);

  const datums = useMemo<TileDatum[]>(() => {
    const total = file.total;
    const head2 = lerpLab(colours.band, colours.surface, 0.55);
    const fillOf = (ret: number | null): RGB => (ret === null ? colours.surface : returnColor(ret, CLAMP, colours.scale));
    const retRow = (n: LNode, avg: boolean) => ({
      label: `${avg ? "Average return / yr" : "Return / yr"}, ${periodLabel}`,
      value: n.ret === null ? "–" : pct(n.ret),
      color: n.ret === null ? undefined : rgbCss(fillOf(n.ret)),
    });
    const tipFor = (t: LTile): TipContent => {
      const n = t.node;
      if (n.kind === "fund") {
        const firm = n.n > 1 && n.members?.length ? n.members : null;
        return {
          title: n.name,
          rows: [
            { label: "13F holdings", value: aum(n.value), big: true },
            { label: "Share of all filers", value: share(n.value / total) },
            ...(firm ? [{ label: "Filers", value: count(n.n) }] : []),
            retRow(n, !!firm),
          ],
          note: firm
            ? `Files as ${firm.slice(0, 4).join(", ")}${firm.length > 4 ? ` and ${firm.length - 4} more` : ""}. Click to open ${firm[0]}.`
            : n.ret === null
              ? "No return for this period: the record is shorter, or too little of it is priced."
              : "Click to open the fund.",
        };
      }
      if (n.kind === "rest") {
        const names = (n.others ?? []).slice(0, 6).map((o) => o.label).join(", ");
        return {
          title: `${n.label} · ${typeLabel(n.type)}`,
          rows: [
            { label: "13F holdings", value: aum(n.value), big: true },
            { label: "Filers", value: count(n.n) },
            retRow(n, true),
          ],
          note:
            (n.value > 0 && n.ret !== null ? `Weighted by holdings; returns for ${share(n.covered / n.value)} of them.` : "") +
            (names ? ` Among them: ${names}${(n.others?.length ?? 0) > 6 ? "…" : "."}` : ""),
        };
      }
      return {
        title: n.label,
        rows: [
          { label: "13F holdings", value: aum(n.value), big: true },
          { label: "Share of all filers", value: share(n.value / total) },
          { label: "Filers", value: count(n.n) },
          retRow(n, true),
        ],
        note: "Weighted by holdings. Click to zoom in.",
      };
    };
    const labels = new Map(file.types.key.map((k, i) => [k, file.types.label[i]]));
    function typeLabel(key: string) {
      return labels.get(key) ?? key;
    }
    return tiles.map((t): TileDatum => {
      const n = t.node;
      const zoomIn = () => onZoom(n.type);
      const label = { other: false, ticker: "", name: "", weight: 0, value: n.value, count: n.n, ret: n.ret };
      if (t.role === "head") {
        const fill = t.depth <= 1 ? colours.band : head2;
        const { ink } = inkFor(fill, colours.ink, colours.surface);
        return {
          key: `h:${n.type}`,
          rect: t.rect,
          other: false,
          fill,
          hollow: false,
          ink,
          soft: false,
          label,
          aria: `${n.label}: ${aum(n.value)}, ${count(n.n, "filer")}. Zoom in.`,
          tip: () => tipFor(t),
          fit: (w, _h, m) => fitHead(n.label, n.value, w, m),
          fixed: true,
          kind: "grp",
          onActivate: zoomIn,
        };
      }
      const rest = t.role === "rest";
      const fill = rest ? null : fillOf(n.ret);
      const { ink, soft } = inkFor(fill ?? colours.band, colours.ink, colours.surface);
      const said = n.ret === null ? "no return for the period" : `${pct(n.ret)} a year over ${periodLabel}`;
      return {
        key: t.role === "box" ? `b:${n.type}` : n.key,
        rect: t.rect,
        other: rest,
        fill,
        hollow: !rest && n.ret === null,
        ink,
        soft,
        label,
        aria: `${n.kind === "rest" ? `${n.label}, ${typeLabel(n.type)}` : n.label}: ${aum(n.value)}, ${said}`,
        tip: () => tipFor(t),
        fit: (w, h, m) => fitTile(n.kind === "rest" ? [n.label, count(n.n)] : n.label, n.value, n.ret, w, h, m),
        kind: t.role === "box" ? "box" : rest ? "rest" : "fund",
        onActivate: t.role === "box" ? zoomIn : n.fundId !== undefined ? () => navigate(`/fund/${n.fundId}`) : undefined,
      };
    });
    // fontsKey: the same tiles, measured again
  }, [tiles, colours, file, periodLabel, onZoom, navigate, fontsKey]);

  useLayoutEffect(() => {
    if (!svgRef.current || !layerRef.current) return;
    const v = createTreemapView(svgRef.current, layerRef.current, { hatch: `url(#${hatchId})`, measure, tip });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [hatchId, measure, tip]);

  // The first drawing waits for the real width (see HoldingsPanel); a zoom or new period moves the tiles.
  const drawn = useRef<{ W: number; theme: number; fonts: number } | null>(null);
  const landedAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const v = view.current;
    const measured = boxRef.current?.clientWidth ?? 0;
    if (!v || (measured > 0 && Math.abs(Math.max(200, measured) - W) > 1)) return;
    const p = drawn.current;
    const t = performance.now();
    const same = p !== null && p.W === W && p.theme === themeKey && p.fonts === fontsKey;
    const joining = landedAt.current !== null && t - landedAt.current < DUR + 150;
    const animate = !reducedMotion() && (landedAt.current === null || same || joining);
    drawn.current = { W, theme: themeKey, fonts: fontsKey };
    v.render(datums, animate);
    if (datums.length && landedAt.current === null) landedAt.current = t;
  }, [datums, W, themeKey, fontsKey]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && path.length > 1) {
      e.preventDefault();
      onZoom(path[path.length - 2].type);
    }
  };

  return (
    <div className="ls" ref={wrapRef}>
      <nav className="ls-crumbs" aria-label="Zoom">
        {path.map((n, i) =>
          i === path.length - 1 ? (
            <span key={n.key} className="ls-here" aria-current="location">
              {n.label}
              <span className="ls-tot">
                {" "}
                {aum(n.value)} · {count(n.n, "filer")}
              </span>
            </span>
          ) : (
            <span key={n.key}>
              <button type="button" className="ls-up" onClick={() => onZoom(n.type)}>
                {n.label}
              </button>
              <span className="ls-sep" aria-hidden="true">
                ›
              </span>
            </span>
          ),
        )}
      </nav>
      <div className="tm-box ls-box" ref={boxRef} style={{ height: H }} onKeyDown={onKey}>
        <svg
          className="tm"
          ref={svgRef}
          role="group"
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          aria-label={`${root.label}: each tile's area is a filer's 13F holdings, its colour the estimated return a year over ${periodLabel}. Arrow keys move between tiles; Enter opens a fund or zooms into a group; Escape zooms out.`}
        >
          <defs>
            <pattern id={hatchId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
              <rect className="tm-hb" width="6" height="6" />
              <line className="tm-hl" x1="3" y1="0" x2="3" y2="6" />
            </pattern>
          </defs>
          <g ref={layerRef} />
        </svg>
      </div>
      {zoom !== ROOT && path.length === 1 && <p className="tm-msg">No filer of this type for the period.</p>}
      <p className="ls-legend">
        <span>
          Return / yr {pct(-CLAMP, 0)}
          <span className="ls-ramp" style={{ background: gradientCss(colours.scale) }} aria-hidden="true" />
          {pct(CLAMP, 0)}
        </span>
        <span>
          <span className="ls-hatch" aria-hidden="true" />
          smaller filers together
        </span>
        <span>
          <span className="ls-hollow" aria-hidden="true" />
          no return for the period
        </span>
      </p>
    </div>
  );
}
