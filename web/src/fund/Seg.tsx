import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import "./base.css";

export type SegOption = { id: string; label: string; icon?: ReactNode; disabled?: boolean };

type SegProps = {
  /** Accessible name of the group. */
  label: string;
  options: SegOption[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
};

/**
 * Segmented control with a thumb that slides to the pressed option (the artifact's
 * `.seg`). Buttons carry aria-pressed; pressing the pressed one does nothing.
 */
export function Seg({ label, options, value, onChange, className }: SegProps) {
  const root = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  // The thumb only tweens after its first placement, so it does not slide in on mount.
  const [ready, setReady] = useState(false);

  const place = useCallback(() => {
    const b = root.current?.querySelector<HTMLElement>('button[aria-pressed="true"]');
    const t = thumb.current;
    if (!b || !t) return;
    t.style.setProperty("--x", b.offsetLeft - 2 + "px");
    t.style.setProperty("--w", b.offsetWidth + "px");
  }, []);

  useLayoutEffect(place, [place, value, options]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Fonts loading or the container resizing move the buttons; follow them.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(place);
      ro.observe(el);
    }
    window.addEventListener("resize", place);
    void document.fonts?.ready.then(place);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [place]);

  return (
    <div className={"seg" + (ready ? " ready" : "") + (className ? " " + className : "")} role="group" aria-label={label} ref={root}>
      <span className="thumb" aria-hidden="true" ref={thumb} />
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          data-v={o.id}
          aria-pressed={o.id === value}
          disabled={o.disabled}
          onClick={() => {
            if (o.id !== value) onChange(o.id);
          }}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
