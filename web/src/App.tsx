import { Link, Route, Routes, useLocation } from "react-router-dom";
import { TooltipProvider } from "./charts/Tooltip";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Logo, Mark } from "./components/Logo";
import Fund from "./pages/Fund";
import Home from "./pages/Home";
import NotFound from "./pages/NotFound";
import Position from "./pages/Position";

export default function App() {
  const { pathname } = useLocation();
  return (
    <>
      <header className="top">
        <div className="wrap topbar">
          <Link className="brand" to="/" aria-label="Orca home">
            <Logo />
          </Link>
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
              <Route path="*" element={<NotFound />} />
            </Routes>
          </ErrorBoundary>
        </TooltipProvider>
      </main>
      <footer className="site-foot">
        <div className="wrap foot-row">
          <Mark className="foot-mark" />
          <p className="cap">
            Estimates from SEC 13F filings. Not investment advice.
          </p>
        </div>
      </footer>
    </>
  );
}
