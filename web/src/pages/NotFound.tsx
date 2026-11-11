import { Link } from "react-router-dom";
import { ThemeToggle } from "../components/ThemeToggle";
import { useTitle } from "../lib/useTitle";
import "./state.css";

/** Unknown route, or a fund or stock that does not exist. */
export default function NotFound() {
  useTitle("Not found · Orca");
  return (
    <>
      <div className="pg-tools">
        <ThemeToggle />
      </div>
      <div className="pg-state">
        <span className="ic">
          <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 9.5l1.75-5.5h7.5l1.75 5.5v3h-11v-3zM2.5 9.5h3.5l.75 1.5h2.5L10 9.5h3.5" />
          </svg>
        </span>
        <h1>Page not found</h1>
        <p>We couldn't find that page. The address may be mistyped, or the fund or stock may not be in Orca's data.</p>
        <div className="row">
          <Link className="pg-btn" to="/">
            Go to the home page
          </Link>
        </div>
      </div>
    </>
  );
}
