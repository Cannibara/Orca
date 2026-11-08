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
import "../fund/base.css";

// One tooltip element shared by every chart under a <TooltipProvider>. Charts get
// the show/hide API from context; showing a tooltip re-renders the provider's own
// output only, never the charts (the API object is stable). The look is the approved
// artifact's: a dark box with a title, rows (label left, value right) and an optional note.
// Its CSS is `#tip.tip` in fund/base.css.

export type TipRow = {
  /** Swatch colour for the row; omit for a plain row. */
  color?: string;
  /** Left-hand text. */
  label?: string;
  /** Right-hand text, bold. */
  value: string;
  /** Larger value (a single headline figure). */
  big?: boolean;
  /** Total row: a rule above it. */
  sum?: boolean;
};
export type TipContent = {
  title: string;
  /** Adds the "Part year" tag after the title. */
  part?: boolean;
  rows: TipRow[];
  /** A muted line under the rows. */
  note?: string;
};

/**
 * Where the box goes. "above": above the point, right of it (flips left near the right
 * edge, below near the top). "cursor": 14px right and below the point (flips near the
 * edges). { pin }: top-left of that element, 70px in and 10px down; the point is ignored.
 */
export type TipPlace = "above" | "cursor" | { pin: HTMLElement };
export type TipOptions = { place?: TipPlace };

export type TooltipApi = {
  /** Show `content` near the viewport point (x, y). */
  show: (content: TipContent, x: number, y: number, opts?: TipOptions) => void;
  hide: () => void;
};

// Without a provider the charts still work, they just have no tooltip.
const NO_TOOLTIP: TooltipApi = { show: () => {}, hide: () => {} };
const TooltipContext = createContext<TooltipApi>(NO_TOOLTIP);

export const useTooltip = (): TooltipApi => useContext(TooltipContext);

/**
 * Event props for a hit target: the tooltip follows the pointer while it is over
 * the target (placed per `opts`, above the point by default), and is anchored above
 * the target's centre while it has keyboard focus. `content` runs on each event, so
 * rows are built only when shown.
 */
export function tipHandlers(api: TooltipApi, content: () => TipContent, opts?: TipOptions) {
  const atPointer = (e: PointerEvent<Element>) => api.show(content(), e.clientX, e.clientY, opts);
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

type Shown = TipContent & { x: number; y: number; place: TipPlace };

const EDGE = 8; // the box never gets closer than this to the viewport edge

function Tooltip({ shown, onEscape }: { shown: Shown | null; onEscape: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = shown !== null;

  // Place it after rendering, once its size is known.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !shown) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { x, y, place } = shown;
    let left: number;
    let top: number;
    if (typeof place === "object") {
      const r = place.pin.getBoundingClientRect();
      left = Math.max(EDGE, Math.min(vw - (w || 170) - EDGE, r.left + 70));
      top = Math.max(EDGE, r.top + 10);
    } else if (place === "cursor") {
      left = x + 14;
      top = y + 14;
      if (left + w > vw - EDGE) left = Math.max(EDGE, x - w - 14);
      if (top + h > vh - EDGE) top = Math.max(EDGE, y - h - 14);
      if (top < EDGE) top = EDGE;
    } else {
      left = x + 14;
      top = y - h - 12;
      if (left + w > vw - EDGE) left = x - w - 14;
      if (left < EDGE) left = EDGE;
      if (top < EDGE) top = y + 16;
    }
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
    <div id="tip" className="tip" role="tooltip" ref={ref} hidden={!shown}>
      {shown && (
        <>
          <div className="t">
            {shown.title}
            {shown.part && <span className="tag hollow">Part year</span>}
          </div>
          {shown.rows.map((r, i) => (
            <div className={"v" + (r.big ? " big" : "") + (r.sum ? " sum" : "")} key={i}>
              {r.color && <i style={{ background: r.color }} />}
              {r.label && <span className="vl">{r.label}</span>}
              <span className="vv">{r.value}</span>
            </div>
          ))}
          {shown.note && <div className="x">{shown.note}</div>}
        </>
      )}
    </div>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const api = useMemo<TooltipApi>(
    () => ({
      show: (content, x, y, opts) => setShown({ ...content, x, y, place: opts?.place ?? "above" }),
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
