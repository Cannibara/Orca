import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

// One tooltip element shared by every chart under a <TooltipProvider>. Charts get
// the show/hide API from context; showing a tooltip re-renders the provider's own
// output only, never the charts (the API object is stable).

export type TipRow = {
  /** Swatch colour for the row; omit for a plain row. */
  color?: string;
  value: string;
  label?: string;
};
export type TipContent = { title: string; rows: TipRow[] };

export type TooltipApi = {
  /** Show `content` near the viewport point (x, y). */
  show: (content: TipContent, x: number, y: number) => void;
  hide: () => void;
};

// Without a provider the charts still work, they just have no tooltip.
const NO_TOOLTIP: TooltipApi = { show: () => {}, hide: () => {} };
const TooltipContext = createContext<TooltipApi>(NO_TOOLTIP);

export const useTooltip = (): TooltipApi => useContext(TooltipContext);

/**
 * Event props for a hit target: the tooltip follows the pointer while it is over
 * the target, and is anchored above the target's centre while it has keyboard
 * focus. `content` runs on each event, so rows are built only when shown.
 */
export function tipHandlers(api: TooltipApi, content: () => TipContent) {
  const atPointer = (e: PointerEvent<Element>) => api.show(content(), e.clientX, e.clientY);
  return {
    onPointerEnter: atPointer,
    onPointerMove: atPointer,
    onPointerLeave: () => api.hide(),
    onFocus: (e: FocusEvent<Element>) => {
      const b = e.currentTarget.getBoundingClientRect();
      api.show(content(), b.left + b.width / 2, b.top);
    },
    onBlur: () => api.hide(),
  };
}

type Shown = TipContent & { x: number; y: number };

function Tooltip({ shown, onEscape }: { shown: Shown | null; onEscape: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = shown !== null;

  // Place it after rendering, once its size is known: right of and above the point,
  // flipped left near the right edge, below the point near the top.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !shown) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = shown.x + 14;
    let top = shown.y - h - 12;
    if (left + w > window.innerWidth - 8) left = shown.x - w - 14;
    if (left < 8) left = 8;
    if (top < 8) top = shown.y + 16;
    el.style.left = left + "px";
    el.style.top = top + "px";
  }, [shown]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, onEscape]);

  return (
    <div id="tip" role="tooltip" ref={ref} hidden={!shown}>
      {shown && (
        <>
          <div className="t">{shown.title}</div>
          {shown.rows.map((r, i) => (
            <div className="r" key={i}>
              {r.color && <i className="lk" style={{ background: r.color }} />}
              <b>{r.value}</b>
              <span>{r.label ?? ""}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const api = useMemo<TooltipApi>(
    () => ({
      show: (content, x, y) => setShown({ ...content, x, y }),
      hide: () => setShown(null),
    }),
    [],
  );
  return (
    <TooltipContext.Provider value={api}>
      {children}
      <Tooltip shown={shown} onEscape={api.hide} />
    </TooltipContext.Provider>
  );
}
