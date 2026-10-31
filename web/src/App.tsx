import { Link, NavLink, Route, Routes } from "react-router-dom";

// Placeholder page: later tasks replace each one with a real page from src/pages/.
function Stub({ title }: { title: string }) {
  return <h1>{title}</h1>;
}

export default function App() {
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
        <Routes>
          <Route path="/" element={<Stub title="Home" />} />
          <Route path="/fund/:id" element={<Stub title="Fund" />} />
          <Route path="/fund/:id/stock/:stockId" element={<Stub title="Position" />} />
          <Route path="/how-it-works" element={<Stub title="How it works" />} />
          <Route path="*" element={<Stub title="Page not found" />} />
        </Routes>
      </main>
    </>
  );
}
