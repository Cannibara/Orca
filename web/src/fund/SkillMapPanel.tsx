import { useMemo, useRef, useState } from "react";
import { tipHandlers, useTooltip } from "../charts/Tooltip";
import { shortNameOf } from "../lib/famousNames";
import type { FundsIndex, SectorScores, Skill, TopRow } from "../data/types";
import { ChartSlot } from "./ChartSlot";
import { qShort } from "./fmt";
import { textW } from "./geometry";
import { useWidth } from "./hooks";
import { Seg } from "./Seg";
import { isEligible, peersFor, placeMapLabels, pts, quadrant, rollingPath, tierOf, tierWords, TIERS, type Corner, type Peer, type Tier, type TierWords } from "./skill";
import "./skill.css";
import { SkTable, ViewButton } from "./StackedPanel";

const BAND = 0.008; // ±0.8 pts a year: too close to call

export type MapProps = {
  fundId: number;
  name: string;
  skill: Skill;
  tier: Tier;
  onTier: (t: Tier) => void;
  scores: SectorScores | null;
  famous: TopRow[] | undefined;
  funds: FundsIndex | null;
};

const cornerName = (c: Exclude<Corner, "close">, w: TierWords) => ({ both: "Both", stock: "Stock picker", sector: w.picker, neither: "Neither, so far" })[c];

/** "beat their industries by +2.3 pts" or "trailed their industries by 1.2 pts". */
function beat(what: string, v: number) {
  const up = v >= 0;
  return (
    <>
      {up ? "beat " : "trailed "}
      {what} by <span className={up ? "g" : "l"}>{up ? pts(v) : pts(-v).replace(/^\+/, "")}</span>
    </>
  );
}

function TierSwitch({ tier, onTier }: { tier: Tier; onTier: (t: Tier) => void }) {
  return (
    <Seg
      label="Judge choices at"
      options={TIERS.map((t) => ({ id: String(t), label: tierWords(t).Noun }))}
      value={String(tier)}
      onChange={(v) => onTier(Number(v) as Tier)}
    />
  );
}

/** "What kind of investor?": this fund and its peers, by stock choice (across) and sector choice (up). */
export function SkillMapPanel({ fundId, name, skill, tier, onTier, scores, famous, funds }: MapProps) {
  const w = tierWords(tier);
  const T = tierOf(skill, tier);
  const me = shortNameOf(fundId, name); // the home page's short names (lib/famousNames)
  const span = skill.last_q - skill.first_q + 1;
  const firstYear = 2013 + Math.floor(skill.first_q / 4);
  const eligible = T.picking != null && T.allocation != null && isEligible({ span_q: span, n: T.n ?? 0, coverage: T.coverage ?? 0 });
  const peers = useMemo(() => (scores && funds ? peersFor(fundId, tier, famous, scores, funds) : { lists: [], similar: [] as Peer[] }), [fundId, tier, famous, scores, funds]);
  const [listName, setListName] = useState<string | null>(null);
  const [path, setPath] = useState(false);
  const [table, setTable] = useState(false);
  const list = peers.lists.find((l) => l.name === listName) ?? peers.lists[0];
  const shown: Peer[] = list ? list.peers : (peers.similar ?? []);
  const header = (
    <div className="ph">
      <div className="ph-t">
        <h3 className="pt" id="mapTitle">
          What kind of investor?
        </h3>
        <p className="ps">Yearly points gained vs the market, split in two · since {firstYear} · estimate</p>
      </div>
      <div className="ph-c">
        <TierSwitch tier={tier} onTier={onTier} />
        {eligible && peers.lists.length > 1 && (
          <Seg label="Compare with" options={peers.lists.map((l) => ({ id: l.name, label: l.name }))} value={list?.name ?? ""} onChange={setListName} />
        )}
        {eligible && (
          <label className="check">
            <input type="checkbox" checked={path} onChange={(e) => setPath(e.target.checked)} />
            Show its path
          </label>
        )}
        {eligible && <ViewButton table={table} onToggle={() => setTable((t) => !t)} />}
      </div>
    </div>
  );
  if (!eligible) {
    // Name the real reason: a fund with years of trades and many picks is not "too early" (owner 2026-11-26: Berkshire,
    // 108 quarters and 128 picks, read "Too early to tell" when only its coverage fell short)
    const young = span < 12 || (T.n ?? 0) < 20;
    const covered = T.coverage != null ? Math.round(T.coverage * 100) : null;
    return (
      <section className="panel skp mapp" aria-labelledby="mapTitle">
        {header}
        <div className="pb">
          <div className="state">
            <h4>{young ? "Too early to tell" : "Too little of its buying could be scored"}</h4>
            {young ? (
              <p>
                The map needs 3 years of trades and 20 picks, with most of the buying scored; this fund has {span} quarters and {T.n ?? 0} picks
                {covered != null && covered < 80 ? `, and ${covered}% of its buying could be scored` : ""}.
              </p>
            ) : (
              <p>
                The map needs at least 80% of a fund's buying matched to a sector with prices; for this fund {covered ?? "–"}% could be. The rest
                went into funds, bonds or stocks without a sector or prices for those years.
              </p>
            )}
          </div>
        </div>
      </section>
    );
  }
  const pick = T.picking as number;
  const alloc = T.allocation as number;
  const corner = quadrant(pick, alloc, BAND);
  const same = shown.filter((p) => quadrant(p.pick, p.alloc, BAND) === corner).length;
  const among = list ? (
    <>
      Among the {shown.length + 1} funds in <b>{list.name}</b>
    </>
  ) : (
    <>Among {shown.length + 1} funds of a similar size</>
  );
  return (
    <section className="panel skp mapp" aria-labelledby="mapTitle">
      {header}
      <p className="say">
        {among}, {me} is {corner === "close" ? <><b>too close to call</b> either way</> : <>in the <b>{cornerName(corner, w)}</b> corner</>}: its stocks{" "}
        {beat("their " + w.plural, pick)} a year and its {w.plural} {beat("the market", alloc)}
        {corner === "close" ? ", gaps that small are often chance" : ""}.{" "}
        {corner === "close"
          ? same === 0
            ? "No other is that close."
            : same === 1
              ? "1 other is that close too."
              : `${same} others are that close too.`
          : same === 0
            ? "No other made it there."
            : same === 1
              ? "1 other made it there."
              : `${same} others made it there.`}
      </p>
      {tier === 3 && <p className="note">Some sub-industries have few stocks, so their index leans on one or two companies.</p>}
      <div className="pb">
        <MapChart me={{ name: me, pick, alloc, n: T.n ?? 0 }} peers={shown} w={w} path={path ? rollingPath(skill, tier) : []} table={table} />
      </div>
      <p className="pf">
        Units. "pts a year" means percentage points of yearly return: +2 pts = 2% a year more, e.g. 12% a year instead of 10%. Measured on their own
        money since {firstYear}: each quarter, the dollars they held in each stock, against the same dollars in that stock's {w.noun} and in the whole
        market. Across: the dollars its stocks beat their own {w.plural} by. Up: the dollars its {w.plural} beat the whole market by. Both ÷ the
        dollar-years at work.
        The grey cross near zero is "too close to call": a gap that small is often chance. Dot size = number of picks.
      </p>
    </section>
  );
}

type Dot = { name: string; pick: number; alloc: number; n: number };

function MapChart({ me, peers, w, path, table }: { me: Dot; peers: Peer[]; w: TierWords; path: { q: number; pick: number; alloc: number }[]; table: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const W = useWidth(host, 280, 600);
  const tip = useTooltip();
  const narrow = W < 520;
  const H = narrow ? Math.round(W * 1.02) : Math.min(460, Math.round(W * 0.56));
  const vals = [me.pick, me.alloc, ...peers.flatMap((p) => [p.pick, p.alloc]), ...path.flatMap((p) => [p.pick, p.alloc])].map(Math.abs);
  const lim = Math.max(0.04, Math.ceil(Math.max(...vals) / 0.02) * 0.02 + 0.01);
  const L = narrow ? 50 : 70;
  const R = W - (narrow ? 10 : 30);
  const top = 12;
  const bot = H - (narrow ? 46 : 52);
  const x = (v: number) => L + ((v + lim) / (2 * lim)) * (R - L);
  const y = (v: number) => bot - ((v + lim) / (2 * lim)) * (bot - top);
  const step = lim > 0.07 ? 0.04 : 0.02;
  const ticks: number[] = [];
  for (let t = -Math.floor(lim / step) * step; t <= lim + 1e-9; t += step) ticks.push(Math.round(t / step) * step);
  const tickText = (t: number) => (Math.abs(t) < 1e-9 ? "0" : (t > 0 ? "+" : "−") + Math.round(Math.abs(t) * 100));
  const dotTip = (d: Dot, mine: boolean) => ({
    title: d.name + (mine ? " (this fund)" : ""),
    rows: [
      { label: "Stock choice", value: pts(d.pick) + " a year" },
      { label: w.choice, value: pts(d.alloc) + " a year" },
      { label: "Picks", value: String(d.n) },
    ],
  });
  const corner = (x0: number, yb: number, t: string, right: boolean) => {
    const tw = textW(t, 14);
    return { x0: right ? x0 - tw : x0, x1: right ? x0 : x0 + tw, y0: yb - 14, y1: yb + 3 };
  };
  // every dot gets a name clear of the others, of every dot and of the corner labels (a number and a key below
  // the map where none fits)
  const rOf = (n: number) => 4 + Math.sqrt(n) / 2.4;
  const labels = placeMapLabels(
    { id: 0, cx: x(me.pick), cy: y(me.alloc), r: 10, name: me.name, n: me.n },
    peers.map((p) => ({ id: p.fund_id, cx: x(p.pick), cy: y(p.alloc), r: rOf(p.n), name: p.name, n: p.n })),
    [
      corner(L + 10, top + 20, w.picker, false),
      corner(R - 10, top + 20, "Both", true),
      corner(L + 10, bot - 12, "Neither, so far", false),
      corner(R - 10, bot - 12, "Stock picker", true),
      ...ticks.map((t) => ({ x0: 0, x1: L - 2, y0: y(t) - 9, y1: y(t) + 6 })), // the axis numbers on the left
      { x0: 0, x1: W, y0: bot + 2, y1: H }, // and below
    ],
    W,
    H,
  );
  const keyed = peers.filter((p) => labels.peers.get(p.fund_id)?.key != null).sort((a, b) => labels.peers.get(a.fund_id)!.key! - labels.peers.get(b.fund_id)!.key!);
  return (
    <div className="chart" ref={host}>
      <ChartSlot table={table}>
        <svg className="viz" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="group" aria-label={`Funds by stock choice (across) and ${w.choice.toLowerCase()} (up), points a year.`}>
          <rect className="band" x={x(-BAND)} y={top} width={x(BAND) - x(-BAND)} height={bot - top} />
          <rect className="band" x={L} y={y(BAND)} width={R - L} height={y(-BAND) - y(BAND)} />
          {ticks.map((t) => (
            <g key={t}>
              <text className="tick" x={x(t)} y={bot + 16} textAnchor="middle">
                {tickText(t)}
              </text>
              <text className="tick" x={L - 8} y={y(t) + 4} textAnchor="end">
                {tickText(t)}
              </text>
            </g>
          ))}
          <line className="axis" x1={x(0)} x2={x(0)} y1={top} y2={bot} />
          <line className="axis" x1={L} x2={R} y1={y(0)} y2={y(0)} />
          <text className="atitle" x={(L + R) / 2} y={bot + 38} textAnchor="middle">
            Stock choice → beating their own {w.plural}, pts a year
          </text>
          <text className="atitle" x={12} y={(top + bot) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(top + bot) / 2})`}>
            {w.choice} → {w.plural} vs market
          </text>
          <text className="corner" x={L + 10} y={top + 20}>
            {w.picker}
          </text>
          <text className="corner" x={R - 10} y={top + 20} textAnchor="end">
            Both
          </text>
          <text className="corner" x={L + 10} y={bot - 12}>
            Neither, so far
          </text>
          <text className="corner" x={R - 10} y={bot - 12} textAnchor="end">
            Stock picker
          </text>
          {peers.map((p) => {
            const r = rOf(p.n);
            const lab = labels.peers.get(p.fund_id);
            return (
              <g key={p.fund_id} className="pt-g" tabIndex={0} role="img" aria-label={`${p.name}: stock choice ${pts(p.pick)} a year, ${w.choice.toLowerCase()} ${pts(p.alloc)} a year, ${p.n} picks`} {...tipHandlers(tip, () => dotTip(p, false))}>
                <circle className="peer" cx={x(p.pick)} cy={y(p.alloc)} r={r} />
                {lab && (
                  <text className="pname" x={lab.x} y={lab.y} textAnchor={lab.anchor}>
                    {lab.key ?? p.name}
                  </text>
                )}
              </g>
            );
          })}
          {path.length > 1 && (
            <g>
              <path className="trail" d={path.map((p, i) => (i ? "L" : "M") + x(p.pick).toFixed(1) + " " + y(p.alloc).toFixed(1)).join(" ")} />
              {path.map((p, i) => (
                <g key={p.q} tabIndex={0} role="img" aria-label={`3 years to ${qShort(p.q)}: stock choice ${pts(p.pick)}, ${w.choice.toLowerCase()} ${pts(p.alloc)}`} {...tipHandlers(tip, () => ({ title: "3 years to " + qShort(p.q), rows: [{ label: "Stock choice", value: pts(p.pick) + " a year" }, { label: w.choice, value: pts(p.alloc) + " a year" }] }))}>
                  <circle className="tdot" cx={x(p.pick)} cy={y(p.alloc)} r={3.5} opacity={0.4 + (0.6 * i) / (path.length - 1)} />
                  {(i === 0 || i === path.length - 1 || i % 3 === 0) && (
                    <text className="tyear" x={x(p.pick) + 7} y={y(p.alloc) - 6}>
                      {"’" + String(2013 + Math.floor(p.q / 4)).slice(2)}
                    </text>
                  )}
                </g>
              ))}
            </g>
          )}
          <g tabIndex={0} role="img" aria-label={`${me.name}, this fund: stock choice ${pts(me.pick)} a year, ${w.choice.toLowerCase()} ${pts(me.alloc)} a year`} {...tipHandlers(tip, () => dotTip(me, true))}>
            <circle className="me" cx={x(me.pick)} cy={y(me.alloc)} r={10} />
            <text className="mename" x={labels.me.x} y={labels.me.y} textAnchor={labels.me.anchor}>
              {me.name}
            </text>
          </g>
        </svg>
        {keyed.length > 0 && (
          <p className="mapkey">
            {keyed.map((p, i) => (
              <span key={p.fund_id}>
                {i > 0 && " · "}
                <b>{labels.peers.get(p.fund_id)!.key}</b> {p.name}
              </span>
            ))}
          </p>
        )}
      </ChartSlot>
      {table && (
        <SkTable
          caption={`Stock choice and ${w.choice.toLowerCase()}, points a year`}
          head={["Fund", "Stock choice", w.choice, "Picks"]}
          rows={[{ ...me, fund_id: 0 }, ...peers].map((p) => [p.name, pts(p.pick), pts(p.alloc), String(p.n)])}
        />
      )}
    </div>
  );
}
