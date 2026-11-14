import { Link } from "react-router-dom";
import { Mark } from "../components/Logo";
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
        <span className="ic brand-ic">
          <Mark />
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
