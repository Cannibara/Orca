import { Fragment, useId, useState, type ReactNode } from "react";
import type { Summary } from "../data/types";
import { aboutRows, describeFiler, edgarUrl, titleCase } from "./about";
import "./about.css";

/** Other managers listed before "Show all N". */
const FIRST_MANAGERS = 4;

/**
 * What SEC EDGAR says about the filer, from summary.json `about` (the filer's record and its latest 13F cover
 * page): a sentence built from the facts, then label / value rows, each only when known. Nothing beyond SEC
 * data. A fund without the block says so.
 */
export function AboutPanel({ summary }: { summary: Summary }) {
  const a = summary.about ?? null;
  const [all, setAll] = useState(false);
  const moreId = useId();
  const rows = a ? aboutRows(a) : [];
  const managers = (a?.other_managers ?? []).filter((m) => m.trim() !== "").map(titleCase);
  const before = rows.filter((r) => r.key === "hq" || r.key === "signed");
  const after = rows.filter((r) => r.key !== "hq" && r.key !== "signed");
  const row = (label: string, value: ReactNode, key = label) => (
    <Fragment key={key}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </Fragment>
  );

  return (
    <section className="panel" id="aboutPanel" aria-labelledby="aboutTitle">
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt" id="aboutTitle">
            About
          </h3>
        </div>
      </div>
      {a === null ? (
        <p className="ab-none">No SEC details yet</p>
      ) : (
        <>
          <div className="ab">
            <p className="ab-d">{describeFiler(a, summary)}</p>
            <dl className="ab-kv">
              {before.map((r) => row(r.label, r.value, r.key))}
              {managers.length > 0 &&
                row(
                  "Other managers in the report",
                  <>
                    {managers.slice(0, FIRST_MANAGERS).join(", ")}
                    {managers.length > FIRST_MANAGERS && (
                      <>
                        <span id={moreId} hidden={!all}>
                          {", " + managers.slice(FIRST_MANAGERS).join(", ")}
                        </span>{" "}
                        <button type="button" className="ab-more" aria-expanded={all} aria-controls={moreId} onClick={() => setAll((x) => !x)}>
                          {all ? "Show fewer" : `Show all ${managers.length}`}
                        </button>
                      </>
                    )}
                  </>,
                  "managers",
                )}
              {after.map((r) => row(r.label, r.value, r.key))}
              {row(
                "SEC CIK",
                <a href={edgarUrl(summary.cik)} target="_blank" rel="noopener noreferrer">
                  {summary.cik}
                  <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5" />
                  </svg>
                  <span className="vh"> (EDGAR filings, opens in a new tab)</span>
                </a>,
                "cik",
              )}
            </dl>
          </div>
          <p className="ab-src">From SEC EDGAR: the filer's record and its latest 13F cover page.</p>
        </>
      )}
    </section>
  );
}
