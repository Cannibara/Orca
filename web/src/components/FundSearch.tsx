import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { loadFunds } from "../data/api";
import type { FundsIndex } from "../data/types";
import { count } from "../lib/format";
import { useLoad } from "../lib/useLoad";
import { fBook } from "../pages/homeFmt";
import "./search.css";

// The fund search: in the top bar on every page (owner, 2026-11-23; it was in the home page's tab row).
// Type a name, pick a match or press Enter (or Open fund) for the best one. "/" focuses it from anywhere.

const MAX_MATCHES = 8;
type Match = { id: number; name: string; book: number; n: number };

/** Case-insensitive substring match on fund names; names that start with the text come first, then larger books. */
function matchFunds(funds: FundsIndex, query: string): Match[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: (Match & { rank: number })[] = [];
  funds.name.forEach((name, i) => {
    const at = name.toLowerCase().indexOf(q);
    if (at >= 0)
      hits.push({
        id: funds.id[i],
        name,
        book: funds.book[i],
        n: funds.n[i],
        rank: at === 0 ? 0 : 1,
      });
  });
  hits.sort((a, b) => a.rank - b.rank || b.book - a.book);
  return hits.slice(0, MAX_MATCHES);
}

export function FundSearch() {
  const navigate = useNavigate();
  // The fund list is fetched only once the reader reaches for the search (a pointer over it, or focus): a
  // fund page has no other use for it. Until then the load stays pending.
  const [wanted, setWanted] = useState(false);
  const want = () => setWanted(true);
  const funds = useLoad(() => (wanted ? loadFunds() : new Promise<FundsIndex>(() => {})), [wanted]);
  const [query, setQuery] = useState("");
  // The results can be put away (Escape, or focus leaving the box) without losing the text; typing or focus brings them back.
  const [open, setOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  // The bar stays put from page to page: opening a fund leaves an empty box behind.
  const { pathname } = useLocation();
  useEffect(() => setQuery(""), [pathname]);
  const matches = useMemo(
    () => (funds.status === "ready" ? matchFunds(funds.data, query) : []),
    [funds, query],
  );
  const typed = query.trim() !== "";
  const showing = typed && open && funds.status !== "error";

  // "/" jumps to the search from anywhere that is not a text field (the hint in the field says so).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key !== "/" ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.defaultPrevented
      )
        return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="search-box"
      onPointerEnter={want}
      onFocus={() => {
        want();
        setOpen(true);
      }}
      onBlur={(e) => {
        // Focus moving to something else inside the box (the button, a result) keeps the results open.
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !showing) return;
        e.preventDefault(); // a search field would otherwise clear itself
        input.current?.focus(); // (before closing: focusing the box opens the results)
        setOpen(false);
      }}
    >
      <form
        className="search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches.length > 0) navigate(`/fund/${matches[0].id}`);
        }}
      >
        {/* Hidden: the field sits in the top bar, which has no room for a caption above it. */}
        <label htmlFor="fund-search" className="vh">
          Search a fund or manager
        </label>
        <div className="in-wrap">
          <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.25" />
            <path d="M10.2 10.2 13.5 13.5" />
          </svg>
          <input
            ref={input}
            id="fund-search"
            type="search"
            placeholder="Type a fund name"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
          />
          <kbd className="kbd" aria-hidden="true">
            /
          </kbd>
        </div>
        <button
          className="btn btn-secondary"
          type="submit"
          disabled={matches.length === 0}
        >
          Open fund
        </button>
      </form>
      {funds.status === "error" && (
        <p className="search-note" role="status">
          Search isn't available right now. The fund list didn't load.
        </p>
      )}
      {showing && (
        // A press on the results must not take focus from the box, or the results would close before the click lands.
        <div className="results" onMouseDown={(e) => e.preventDefault()}>
          {funds.status === "loading" ? (
            <p role="status">Loading funds…</p>
          ) : matches.length === 0 ? (
            <p role="status">No fund matches "{query.trim()}".</p>
          ) : (
            <ul aria-label="Matching funds">
              {matches.map((m) => (
                <li key={m.id}>
                  <Link to={`/fund/${m.id}`}>
                    <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M2.5 13.5h11M4 13.5v-10h8v10M6.5 6h3M6.5 8.5h3M6.5 11h3" />
                    </svg>
                    <span className="nm">{m.name}</span>
                    <span className="rt">
                      {fBook(m.book)} · {count(m.n, "position")}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

