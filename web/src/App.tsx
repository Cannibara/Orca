import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { TooltipProvider } from "./charts/Tooltip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import Fund from "./pages/Fund";
import Home from "./pages/Home";
import Method from "./pages/Method";
import NotFound from "./pages/NotFound";
import Position from "./pages/Position";

export default function App() {
  const { pathname } = useLocation();
  return (
    <>
      <header className="top">
        <div className="wrap topbar">
          <Link className="brand" to="/" aria-label="Orca home">
            <svg viewBox="0 0 32 32" aria-hidden="true">
              <path
                d="M3 19c3-8 11-12 19-10 3 .8 5 2.6 7 5-2 0-3.4.6-4.6 1.8.9 2.4.3 5-2 6.6-3 2-7 1.6-10.4 0L9 25l.6-4C7 21.2 4.8 20.6 3 19z"
                fill="var(--ink)"
              />
              <path d="M19 17.5c1.6-.3 3 .2 3.8 1.4-1.4 1-3.2 1.1-4.8.5z" fill="var(--surface)" />
              <circle cx="22.5" cy="13" r="1.2" fill="var(--surface)" />
            </svg>
            Orca
          </Link>
          <nav className="nav" aria-label="Pages">
            <NavLink to="/" end>
              Home
            </NavLink>
            <NavLink to="/how-it-works">How it works</NavLink>
          </nav>
        </div>
      </header>
      <main className="wrap">
        {/* One shared tooltip for every chart on every page: mounted here, never per page. */}
        <TooltipProvider>
          {/* Keyed by the path, so moving to another page leaves a failed one behind. */}
          <ErrorBoundary key={pathname}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/fund/:id" element={<Fund />} />
              <Route path="/fund/:id/stock/:stockId" element={<Position />} />
              <Route path="/how-it-works" element={<Method />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </ErrorBoundary>
        </TooltipProvider>
      </main>
    </>
  );
}
