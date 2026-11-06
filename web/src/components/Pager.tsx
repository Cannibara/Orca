import { count } from "../lib/format";

type Props = {
  /** Zero-based page shown. */
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  /** What the rows are, for the summary and the buttons' names ("funds"). */
  noun: string;
};

/** "Showing 101–200 of 1,234 funds" with Previous and Next buttons, also when everything fits on one
 * page (both buttons then disabled), so every paged list reads the same; nothing for an empty list. */
export function Pager({ page, pageSize, total, onPage, noun }: Props) {
  const pages = Math.ceil(total / pageSize);
  if (total === 0) return null;
  const first = page * pageSize + 1;
  const last = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="pager" aria-label={`Pages of ${noun}`}>
      <span className="pager-sum">
        Showing {count(first)}–{count(last)} of {count(total)} {noun}
      </span>
      <span className="pager-btns">
        <button type="button" className="chip" onClick={() => onPage(page - 1)} disabled={page === 0}>
          Previous
        </button>
        <span className="pager-at">
          Page {page + 1} of {pages}
        </span>
        <button type="button" className="chip" onClick={() => onPage(page + 1)} disabled={page >= pages - 1}>
          Next
        </button>
      </span>
    </nav>
  );
}
