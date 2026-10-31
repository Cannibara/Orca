import { Link } from "react-router-dom";
import { useTitle } from "../lib/useTitle";

/** Unknown route, or a fund or stock that does not exist. */
export default function NotFound() {
  useTitle("Not found · Orca");
  return (
    <div className="view">
      <div className="sec">
        <h1>Page not found</h1>
        <p className="lede">
          We couldn't find that page. The address may be mistyped, or the fund or stock may not be in Orca's data.{" "}
          <Link to="/">Go to the home page</Link>.
        </p>
      </div>
    </div>
  );
}
