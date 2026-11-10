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
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect width="24" height="24" rx="6" fill="var(--inv)" />
              <ellipse cx="15.6" cy="9" rx="4.6" ry="2.5" transform="rotate(-24 15.6 9)" fill="var(--invfg)" />
              <path d="M4.5 16.2c3.4 1.8 9.2 2 15-.6" fill="none" stroke="var(--invfg)" strokeWidth="1.6" strokeLinecap="round" />
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
      <footer className="site-foot">
        <div className="wrap">
          <p className="cap">
            Estimates from SEC 13F filings. Not investment advice. <Link to="/how-it-works">How it works</Link>
          </p>
        </div>
      </footer>
    </>
  );
}
