import type { ReactNode } from "react";

/**
 * The artifact's empty / error state: a dashed card with a small icon, an optional title and a line
 * of explanation. An error is announced (role="alert"); an empty list is plain text.
 */
export function State({ kind = "empty", title, children }: { kind?: "empty" | "error"; title?: string; children?: ReactNode }) {
  const error = kind === "error";
  return (
    <div className={error ? "state err" : "state"} role={error ? "alert" : undefined}>
      <span className="ic" aria-hidden="true">
        <svg className="ico" viewBox="0 0 16 16">
          {error ? (
            <>
              <path d="M8 2.5 14 13H2L8 2.5z" />
              <path d="M8 6.75v3M8 11.4v.01" />
            </>
          ) : (
            <>
              <circle cx="8" cy="8" r="6" />
              <path d="M8 7.5v3.25M8 5.25v.01" />
            </>
          )}
        </svg>
      </span>
      {title && <h4>{title}</h4>}
      {children && <p>{children}</p>}
    </div>
  );
}
