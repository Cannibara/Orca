import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ThemeToggle } from "../components/ThemeToggle";
import type { Summary } from "../data/types";
import { fmtDate, money, qOfYear } from "../lib/format";
import "./returns.css";

/** Below this share of the book priced, the header carries a warning pill. */
const COVERAGE_WARN = 0.8;

export type FundTab = "holdings" | "analysis" | "about";

export const FUND_TABS: { id: FundTab; label: string }[] = [
  { id: "holdings", label: "Holdings" },
  { id: "analysis", label: "Analysis" },
  { id: "about", label: "About" },
];

/** The tab a URL hash picks: "#analysis", "#about"; anything else (no hash too) is Holdings. */
export function tabOfHash(hash: string): FundTab {
  const h = hash.replace(/^#/, "");
  return FUND_TABS.some((t) => t.id === h) ? (h as FundTab) : "holdings";
}

/**
 * The fund's name, the line under it (reported book, holdings, last filing), the data-quality warnings and
 * the Holdings / Analysis / About tabs (WAI-ARIA tabs: one Tab stop, the arrows, Home and End move and open).
 * Each tab's panel is `fund-panel-{id}`, labelled by its tab `fund-tab-{id}`.
 */
export function FundHeader({
  summary,
  positionsEver,
  tab,
  onTab,
}: {
  summary: Summary;
  positionsEver: number;
  tab: FundTab;
  onTab: (t: FundTab) => void;
}) {
  const s = summary;
  const tabs = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // The underline slides to the selected tab; it only tweens after its first placement.
  const place = useCallback(() => {
    const el = tabs.current;
    const b = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const ind = el?.querySelector<HTMLElement>(".ind");
    if (!b || !ind) return;
    // Fractional edges (offsetWidth rounds), so the bar spans exactly the tab.
    const er = el!.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    ind.style.setProperty("--x", br.left - er.left + el!.scrollLeft + "px");
    ind.style.setProperty("--w", br.width + "px");
  }, []);
  useLayoutEffect(place, [place, tab]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    const el = tabs.current;
    if (!el) return;
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(place);
      ro.observe(el);
      // The strip keeps its size when the web font swaps in, but each tab gets wider.
      el.querySelectorAll('[role="tab"]').forEach((t) => ro!.observe(t));
    }
    window.addEventListener("resize", place);
    void document.fonts?.ready.then(place);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  // The arrows move to the neighbouring tab (round the ends), Home and End to the first and last, and open it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = FUND_TABS.findIndex((t) => t.id === tab);
    const n = FUND_TABS.length;
    const j = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    const next = FUND_TABS[j].id;
    onTab(next);
    tabs.current?.querySelector<HTMLElement>(`[data-view="${next}"]`)?.focus();
  };

  // Rounded down, so a book that is not fully priced never reads as 100% and a warning never reads "80%".
  const priced = Math.floor(s.priced_pct * 100 + 1e-9);
  const quarter = qOfYear(s.period_q) + 1;
  const holdings = `${s.n_holdings} ${s.n_holdings === 1 ? "holding" : "holdings"} now, ${positionsEver} ${positionsEver === 1 ? "position" : "positions"} ever`;

  return (
    <div className="fh-wrap">
      <header className="fh">
        <div className="fh-main">
          <h1>{s.name}</h1>
          <div className="meta">
            <span className="mi">
              <span>{money(s.book)} reported book</span>
              <i className="sep" aria-hidden="true" />
            </span>
            <span className="mi">
              <span>{holdings}</span>
              <i className="sep" aria-hidden="true" />
            </span>
            <span className="pill">
              <i className="dot live" aria-hidden="true" />
              <span>{`Updated ${fmtDate(s.filed)} · Q${quarter} filing`}</span>
            </span>
            {s.priced_pct < COVERAGE_WARN && (
              <span
                className="pill badge"
                title="Part of this fund's reported book has no price, so its figures cover only the priced part."
              >
                {priced}% of book priced
              </span>
            )}
          </div>
        </div>
        <ThemeToggle className="fh-theme" />
      </header>
      {s.inactive && (
        <p className="fh-note" role="note">
          This fund filed nothing in the latest two quarters, so these figures stop at its last filing.
        </p>
      )}
      <div className={"tabs" + (ready ? " ready" : "")} role="tablist" aria-label="Fund sections" ref={tabs} onKeyDown={onKeyDown}>
        {FUND_TABS.map((t) => (
          <button
            key={t.id}
            id={"fund-tab-" + t.id}
            className="tab"
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            tabIndex={t.id === tab ? 0 : -1}
            data-view={t.id}
            onClick={() => onTab(t.id)}
          >
            {t.label}
            {/* What the fund holds in its newest quarter, not every position it ever had (that is in the line above). */}
            {t.id === "holdings" && <span className="cnt">{s.n_holdings}</span>}
          </button>
        ))}
        <span className="ind" aria-hidden="true" />
      </div>
    </div>
  );
}
