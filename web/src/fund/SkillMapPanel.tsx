import { useMemo, useRef, useState } from "react";
import { tipHandlers, useTooltip } from "../charts/Tooltip";
import { shortNameOf } from "../lib/famousNames";
import type { FundsIndex, SectorScores, Skill, TopRow } from "../data/types";
import { ChartSlot } from "./ChartSlot";
import { qShort } from "./fmt";
import { textW } from "./geometry";
import { useWidth } from "./hooks";
import { Seg } from "./Seg";
import { isEligible, peersFor, pts, quadrant, rollingPath, tierOf, tierWords, TIERS, type Corner, type Peer, type Tier, type TierWords } from "./skill";
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

const cornerName = (c: Corner, w: TierWords) => ({ both: "Both", stock: "Stock picker", sector: w.picker, neither: "Neither, so far" })[c];

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
    return (
      <section className="panel skp mapp" aria-labelledby="mapTitle">
        {header}
        <div className="pb">
          <div className="state">
            <h4>Too early to tell</h4>
            <p>
              The map needs 3 years of trades and 20 picks, with most of the buying scored; this fund has {span} quarters and {T.n ?? 0} picks
              {T.coverage != null && T.coverage < 0.8 ? `, and ${Math.round(T.coverage * 100)}% of its buying could be scored` : ""}.
            </p>
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
        {among}, {me} is in the <b>{cornerName(corner, w)}</b> corner: its stocks {beat("their " + w.plural, pick)} a year and its {w.plural}{" "}
        {beat("the market", alloc)}. {same === 0 ? "No other made it there." : same === 1 ? "1 other made it there." : `${same} others made it there.`}
      </p>
      {tier === 3 && <p className="note">Some sub-industries have few stocks, so their index leans on one or two companies.</p>}
      <div className="pb">
        <MapChart me={{ name: me, pick, alloc, n: T.n ?? 0 }} peers={shown} w={w} path={path ? rollingPath(skill, tier) : []} table={table} />
      </div>
      <p className="pf">
        Units. "pts a year" means percentage points of yearly return: +2 pts = 2% a year more, e.g. 12% a year instead of 10%. Measured on every
        dollar they put in since {firstYear}. Across: how much its stocks beat their own {w.plural}. Up: how much its {w.plural} beat the whole market.
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
  // peer names beside their dots, biggest first, dropped where they would touch another name or this fund's
  const meBox = { x0: x(me.pick) - 12 - textW(me.name, 13.5), x1: x(me.pick) + 12, y0: y(me.alloc) - 26, y1: y(me.alloc) + 12 };
  const corner = (x0: number, yb: number, t: string, right: boolean) => {
    const tw = textW(t, 14);
    return { x0: right ? x0 - tw : x0, x1: right ? x0 : x0 + tw, y0: yb - 14, y1: yb + 3 };
  };
  // peer names stay clear of this fund's name and of the corner labels
  const placed = [
    meBox,
    corner(L + 10, top + 20, w.picker, false),
    corner(R - 10, top + 20, "Both", true),
    corner(L + 10, bot - 12, "Neither, so far", false),
    corner(R - 10, bot - 12, "Stock picker", true),
  ];
  const named = new Set<number>();
  for (const p of [...peers].sort((a, b) => b.n - a.n)) {
    const r = 4 + Math.sqrt(p.n) / 2.4;
    const bx = { x0: x(p.pick) + r + 2, x1: x(p.pick) + r + 6 + textW(p.name, 11.5), y0: y(p.alloc) - 8, y1: y(p.alloc) + 6 };
    if (bx.x1 > W - 2 || placed.some((q) => bx.x0 < q.x1 && bx.x1 > q.x0 && bx.y0 < q.y1 && bx.y1 > q.y0)) continue;
    placed.push(bx);
    named.add(p.fund_id);
  }
  const meRight = x(me.pick) - 16 - textW(me.name, 13.5) < L + 4;
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
            const r = 4 + Math.sqrt(p.n) / 2.4;
            return (
              <g key={p.fund_id} className="pt-g" tabIndex={0} role="img" aria-label={`${p.name}: stock choice ${pts(p.pick)} a year, ${w.choice.toLowerCase()} ${pts(p.alloc)} a year, ${p.n} picks`} {...tipHandlers(tip, () => dotTip(p, false))}>
                <circle className="peer" cx={x(p.pick)} cy={y(p.alloc)} r={r} />
                {named.has(p.fund_id) && (
                  <text className="pname" x={x(p.pick) + r + 4} y={y(p.alloc) + 4}>
                    {p.name}
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
            <text className="mename" x={meRight ? x(me.pick) + 16 : x(me.pick) - 16} y={y(me.alloc) - 14} textAnchor={meRight ? "start" : "end"}>
              {me.name}
            </text>
          </g>
        </svg>
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
