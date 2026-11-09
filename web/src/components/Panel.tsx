import { useId, type ReactNode } from "react";

/**
 * The artifact's panel: a hairline card with a head (title, a one-line subtitle, controls on the right)
 * and then whatever the body is. The children sit directly under the head, so a table can run edge to
 * edge; wrap text or tools in `.pb` for the panel's padding. Styled by fund/base.css (.panel .ph .pt
 * .ps .ph-c .pb .pf), so render it inside a `.fp` page. The heading names the region.
 */
export function Panel({
  title,
  subtitle,
  controls,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="ph">
        <div className="ph-t">
          <h2 className="pt" id={id}>
            {title}
          </h2>
          {subtitle && <p className="ps">{subtitle}</p>}
        </div>
        {controls && <div className="ph-c">{controls}</div>}
      </div>
      {children}
    </section>
  );
}
