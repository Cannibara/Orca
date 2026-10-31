import type { ReactNode } from "react";

/** A named section: its heading labels the region. `intro` sits beside the heading. */
export function Section({ id, title, intro, children }: { id: string; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="sec" aria-labelledby={id}>
      <div className="sec-head">
        <div>
          <h2 id={id}>{title}</h2>
        </div>
        {intro}
      </div>
      {children}
    </section>
  );
}
