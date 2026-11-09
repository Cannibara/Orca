import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Summary } from "../data/types";
import { fmtDate, money } from "../lib/format";
import { reducedMotion } from "./hooks";
import "./returns.css";

/** Below this share of the book priced, the header carries a warning pill. */
const COVERAGE_WARN = 0.8;

type View = "overview" | "positions";

const TABS: { id: View; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "positions", label: "Positions" },
];

/** Scroll to the top of the page (Overview) or to the Positions panel; smooth unless motion is reduced. */
function goTo(view: View) {
  const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
  if (view === "positions") document.getElementById("posPanel")?.scrollIntoView?.({ behavior, block: "start" });
  else if (typeof window.scrollTo === "function") window.scrollTo({ top: 0, behavior });
}

/**
 * The fund's name, the line under it (reported book, holdings, last filing), the data-quality
 * warnings and the Overview / Positions tabs. Overview and Positions scroll to a place on this
 * one page; they do not switch views.
 */
export function FundHeader({ summary, positionsEver }: { summary: Summary; positionsEver: number }) {
  const s = summary;
  const [view, setView] = useState<View>("overview");
  const tabs = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // The underline slides to the selected tab; it only tweens after its first placement.
  const place = useCallback(() => {
    const el = tabs.current;
    const b = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const ind = el?.querySelector<HTMLElement>(".ind");
    if (!b || !ind) return;
    ind.style.setProperty("--x", b.offsetLeft + "px");
    ind.style.setProperty("--w", String(b.offsetWidth));
  }, []);
  useLayoutEffect(place, [place, view]);
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
    }
    window.addEventListener("resize", place);
    void document.fonts?.ready.then(place);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  const pick = (v: View) => {
    setView(v);
    goTo(v);
  };
  // Left and right arrows move to the neighbouring tab and open it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dx = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dx) return;
    const i = TABS.findIndex((t) => t.id === (document.activeElement as HTMLElement | null)?.dataset.view);
    if (i < 0) return;
    const next = TABS[(i + dx + TABS.length) % TABS.length];
    e.preventDefault();
    pick(next.id);
    tabs.current?.querySelector<HTMLElement>(`[data-view="${next.id}"]`)?.focus();
  };

  // Rounded down, so a book that is not fully priced never reads as 100% and a warning never reads "80%".
  const priced = Math.floor(s.priced_pct * 100 + 1e-9);
  const quarter = (((s.period_q % 4) + 4) % 4) + 1;
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
      </header>
      {s.inactive && (
        <p className="fh-note" role="note">
          This fund filed nothing in the latest two quarters, so these figures stop at its last filing.
        </p>
      )}
      <div className={"tabs" + (ready ? " ready" : "")} role="tablist" aria-label="Fund sections" ref={tabs} onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === view} data-view={t.id} onClick={() => pick(t.id)}>
            {t.label}
            {t.id === "positions" && <span className="cnt">{positionsEver}</span>}
          </button>
        ))}
        <span className="ind" aria-hidden="true" />
      </div>
    </div>
  );
}
