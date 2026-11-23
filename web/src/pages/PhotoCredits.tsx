import { Link } from "react-router";
import { photoCredits } from "../lib/people";
import { useTitle } from "../lib/useTitle";
import "./credits.css";

/** Who took each photo on the Famous funds lists, and under which licence (CC BY and CC BY-SA ask for it). */
export default function PhotoCredits() {
  useTitle("Photo credits · Orca");
  const rows = photoCredits();
  return (
    <div className="credits">
      <h1>Photo credits</h1>
      <p>
        Photos on the Famous funds lists come from Wikimedia Commons, under public domain or Creative Commons licences.
        Photos were cropped and resized. <Link to="/">Back to Orca</Link>
      </p>
      <ul>
        {rows.map((c) => (
          <li key={c.slug}>
            <strong>{c.name}</strong>: {c.author}.{" "}
            <a href={c.source} rel="noreferrer noopener" target="_blank">
              Source
            </a>
            ,{" "}
            {c.licence_url ? (
              <a href={c.licence_url} rel="noreferrer noopener" target="_blank">
                {c.licence}
              </a>
            ) : (
              c.licence
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
