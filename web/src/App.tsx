import { Link, Route, Routes, useLocation } from "react-router-dom";
import { TooltipProvider } from "./charts/Tooltip";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
            {/* The Orca mark (docs/brand/orca-mark-16.svg: the small-size cut, larger eye patch). The
                eye patch is a hole, so it shows the bar behind it in either theme. */}
            <svg viewBox="0 0 96 96" aria-hidden="true">
              <path
                fill="currentColor"
                fillRule="evenodd"
                d="M8.48 79.68A40.81 40.81 0 0 1 22.88 37.38A38.93 38.93 0 0 0 28.85 14.17A2.52 2.52 0 0 1 31.85 11.55A27.48 27.48 0 0 1 52.27 28.95A40.81 40.81 0 0 1 84.80 87.18A0.87 0.87 0 0 1 83.49 87.50A71.72 71.72 0 0 0 9.69 80.24A0.87 0.87 0 0 1 8.48 79.68ZM54.18 52.84A19.50 19.50 0 0 1 80.15 63.97A19.50 19.50 0 0 1 54.18 52.84Z"
              />
            </svg>
            Orca
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
        <div className="wrap">
          <p className="cap">
            Estimates from SEC 13F filings. Not investment advice.
          </p>
        </div>
      </footer>
    </>
  );
}
