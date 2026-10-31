import { Link } from "react-router-dom";

/** Unknown route, or a fund or stock that does not exist. */
export default function NotFound() {
  return (
    <div className="view">
      <h1>Page not found</h1>
      <p className="lede">
        There is nothing at this address. <Link to="/">Go to the home page</Link>.
      </p>
    </div>
  );
}
