import { useMemo, useRef, useState } from "react";
import { tipHandlers, useTooltip, type TipContent } from "../charts/Tooltip";
import type { Stock } from "../data/api";
import type { Skill } from "../data/types";
import { money, pct } from "../lib/format";
import { ChartSlot } from "./ChartSlot";
import { betRows, returnTicks, stockRows, type DecRow } from "./decisions";
import { textW } from "./geometry";
import { useWidth } from "./hooks";
import { Seg } from "./Seg";
import { labelName, pts, tierOf, tierWords, type Tier, type TierWords } from "./skill";
import "./skill.css";
import { SkTable, ViewButton } from "./StackedPanel";

type View = "stock" | "bets";
/** A share of the money in whole percent; a sliver under half a percent reads "<1%", never "0%". */
const share0 = (v: number) => (v > 0 && v < 0.005 ? "<1%" : pct(v, 0, false));

/** Cut `s` with "…" to fit `px` pixels at `size`. */
function fit(s: string, px: number, size: number): string {
  if (textW(s, size) <= px) return s;
  let t = s;
  while (t.length > 1 && textW(t + "…", size) > px) t = t.slice(0, -1);
  return t.trimEnd() + "…";
}

function rowTip(r: DecRow, stock: boolean, w: TierWords): TipContent {
  if (stock) {
    return {
      title: r.lab + (r.rest ? "" : " · " + r.sub),
      rows: [
        { label: "Put in", value: `${money(r.bought)} (${share0(r.share)} of all)` },
        { label: "Its return for them", value: pct(r.choice) + " a year" },
        { label: `${r.rest ? "Their " + w.plural : labelName(r.label)} index, same trades`, value: pct(r.bench) },
        { label: "Beat by", value: pts(r.beat) },
        { label: "Adds to the fund", value: pts(r.adds) + " a year", sum: true },
      ],
    };
  }
  return {
    title: r.lab,
    rows: r.skipped
      ? [
          { label: "Put in", value: "nothing" },
          { label: "The market holds", value: share0(r.mktShare ?? 0) },
        ]
      : [
          { label: "Put in", value: `${money(r.bought)} (${share0(r.share)} of all)` },
          { label: "The market holds", value: r.mktShare == null ? "–" : share0(r.mktShare) },
          { label: `${w.Noun} index, their dates`, value: pct(r.choice) + " a year" },
          { label: "Whole market, same trades", value: pct(r.bench) },
          { label: "Adds to the fund", value: pts(r.adds) + " a year", sum: true },
        ],
    note: r.skipped ? "They bought nothing here: it counts only through the market." : undefined,
  };
}

/** "Which decisions made the gap": each big pick vs its own label's index, or each label they bought vs the market. */
export function DecisionsPanel({ skill, tier, stocks }: { skill: Skill; tier: Tier; stocks: Map<number, Stock> }) {
  const w = tierWords(tier);
  const [view, setView] = useState<View>("stock");
  const [table, setTable] = useState(false);
  const T = tierOf(skill, tier);
  const D = useMemo(() => (view === "stock" ? stockRows(T, stocks) : betRows(T, tier)), [view, T, stocks, tier]);
  if (D.rows.length === 0) return null;
  const stock = view === "stock";
  const named = D.rows.filter((r) => !r.rest && r.beat != null);
  const won = named.filter((r) => (r.beat ?? 0) > 0).length;
  const best = named.reduce<DecRow | null>((a, r) => (a == null || (r.adds ?? 0) > (a.adds ?? 0) ? r : a), null);
  const worst = named.reduce<DecRow | null>((a, r) => (a == null || (r.adds ?? 0) < (a.adds ?? 0) ? r : a), null);
  const big = D.rows.find((r) => !r.skipped && r.beat != null);
  const cls = (v: number | null) => ((v ?? 0) >= 0 ? "g" : "l");
  return (
    <section className="panel skp decp" aria-labelledby="decTitle">
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt" id="decTitle">
            Which decisions made the gap
          </h3>
          <p className="ps">
            {stock
              ? `Each big pick vs its own ${w.noun}'s index, over the time they held it · estimate`
              : `Each ${w.noun}'s whole index, bought on their dates, vs the whole market · their stock picks left out · estimate`}
          </p>
        </div>
        <div className="ph-c">
          <Seg
            label="Decisions"
            options={[
              { id: "stock", label: w.stockView },
              { id: "bets", label: w.betsView },
            ]}
            value={view}
            onChange={(v) => setView(v as View)}
          />
          <ViewButton table={table} onToggle={() => setTable((t) => !t)} />
        </div>
      </div>
      {stock && best && worst ? (
        <p className="say">
          <b>
            {won} of {named.length}
          </b>{" "}
          biggest picks beat their own {w.noun}. <span className={cls(best.adds)}>{best.lab}</span> added the most, about {pts(best.adds)} a year to the
          whole fund; <span className={cls(worst.adds)}>{worst.lab}</span> {(worst.adds ?? 0) < 0 ? "cost the most" : "added the least"} ({pts(worst.adds)}).
        </p>
      ) : !stock && big ? (
        <p className="say">
          {share0(big.share)} of their money went to <b>{big.lab}</b>, where the market holds {big.mktShare == null ? "–" : share0(big.mktShare)}. That {w.noun}{" "}
          {(big.beat ?? 0) >= 0 ? "beat" : "trailed"} the market by {pts(Math.abs(big.beat ?? 0)).replace(/^\+/, "")} a year, so this one bet added about{" "}
          <span className={cls(big.adds)}>{pts(big.adds)}</span> a year. All {w.noun} bets together: about <span className={cls(D.adds)}>{pts(D.adds)}</span>.
        </p>
      ) : null}
      <div className="pb">
        <DecChart rows={D.rows} total={D} stock={stock} w={w} table={table} />
      </div>
      <p className="pf">
        {stock
          ? `Share of their money = dollars put into that stock ÷ all dollars they put in. ● what the stock made a year on the dollars they had in it each quarter, ○ what the same money would have made in the ${w.noun} index. Beat by = the gap in yearly return, in percentage points. Adds = the dollars it gained over the index ÷ all their money at work, in points a year: the rows add up to the fund's stock choice score.`
          : `Bar = share of their money; black tick = the market's share of the same ${w.noun} when they were buying, so a bar past its tick is a bet on that ${w.noun}. ○ the same money in the whole market, ● the same money in the ${w.noun}'s whole index (their stock picks are left out). Adds = the dollars it gained over the market ÷ all their money at work: the rows add up to the fund's ${w.noun} choice score.`}
      </p>
    </section>
  );
}

function DecChart({ rows, total, stock, w, table }: { rows: DecRow[]; total: { bought: number; adds: number }; stock: boolean; w: TierWords; table: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const w0 = useWidth(host, 280, 600);
  const W = Math.max(w0, 640); // narrower screens scroll the chart sideways, never the page
  const tip = useTooltip();
  const rh = 36;
  const top = 56;
  const n = rows.length;
  const H = top + n * rh + 40;
  const NX = 8;
  const BX = Math.round(W * 0.2);
  const BW = Math.round(W * 0.12);
  const DL = Math.round(W * 0.41);
  const DR = Math.round(W * 0.77);
  const EX = Math.round(W * 0.875);
  const AX = W - 10;
  const smax = Math.max(1e-9, ...rows.map((r) => Math.max(r.share, r.mktShare ?? 0)));
  const k = returnTicks(rows);
  const x = (v: number) => DL + ((v - k.lo) / (k.hi - k.lo)) * (DR - DL);
  const sgnCls = (v: number | null) => ((v ?? 0) >= 0 ? "up" : "dn");
  return (
    <div className="chart" ref={host}>
      <ChartSlot table={table}>
        <div className="scroll">
          <svg className="viz" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="group" aria-label={stock ? `Each big pick against its ${w.noun}'s index.` : `Each ${w.noun} they bought against the whole market.`}>
            <text className="hd" x={BX} y={16}>
              Share of their money
            </text>
            <text className="hd" x={(DL + DR) / 2} y={16} textAnchor="middle">
              {stock ? `Stock vs its ${w.noun}, return a year` : `${w.Noun} vs market, return a year`}
            </text>
            <text className="hd" x={EX} y={16} textAnchor="end">
              Beat by
            </text>
            <text className="hd" x={AX} y={16} textAnchor="end">
              Adds
            </text>
            <text className="hs" x={BX} y={30}>
              of all they put in
            </text>
            <text className="hs" x={EX} y={30} textAnchor="end">
              pts
            </text>
            <text className="hs" x={AX} y={30} textAnchor="end">
              pts a year
            </text>
            {k.ticks.map((t) => (
              <g key={t}>
                <line className={Math.abs(t) < 1e-9 ? "axis" : "grid"} x1={x(t)} x2={x(t)} y1={top - 4} y2={top + n * rh} />
                <text className="tick" x={x(t)} y={top - 10} textAnchor="middle">
                  {pct(t, 0)}
                </text>
              </g>
            ))}
            {rows.map((r, i) => {
              const cy = top + i * rh + rh / 2;
              const bw = (BW * r.share) / smax;
              const won = (r.beat ?? 0) >= 0;
              return (
                <g key={r.key} className="row" tabIndex={0} role="img" aria-label={`${r.lab}: ${share0(r.share)} of their money, beat by ${pts(r.beat)}, adds ${pts(r.adds)} a year`} {...tipHandlers(tip, () => rowTip(r, stock, w), { place: "cursor" })}>
                  {i % 2 === 0 && <rect className="zebra" x={0} y={cy - rh / 2} width={W} height={rh} />}
                  <g opacity={r.skipped ? 0.45 : 1}>
                    <text className={"dname" + (stock && !r.rest ? " mono" : "")} x={NX} y={cy - 1}>
                      {fit(r.lab, BX - NX - 10, 13.5)}
                    </text>
                    <text className="dsub" x={NX} y={cy + 13}>
                      {fit(r.sub, BX - NX - 10, 11.5)}
                    </text>
                    <rect className="share" x={BX} y={cy - 6} width={Math.max(bw, r.share > 0 ? 2 : 0)} height={12} rx={2} />
                    <text className="sval" x={BX + bw + 6} y={cy + 4}>
                      {share0(r.share)}
                    </text>
                    {r.mktShare != null && <line className="mtick" x1={BX + (BW * r.mktShare) / smax} x2={BX + (BW * r.mktShare) / smax} y1={cy - 10} y2={cy + 10} />}
                    {r.bench != null && r.choice != null && (
                      <>
                        <line className={"dumb " + (won ? "up" : "dn")} x1={x(r.bench)} x2={x(r.choice)} y1={cy} y2={cy} />
                        <circle className="bench" cx={x(r.bench)} cy={cy} r={5} />
                        <circle className={"pick " + (won ? "up" : "dn")} cx={x(r.choice)} cy={cy} r={5.5} />
                      </>
                    )}
                    <text className={"num " + sgnCls(r.beat)} x={EX} y={cy + 4} textAnchor="end">
                      {r.skipped ? "–" : pts(r.beat).replace(" pts", "")}
                    </text>
                    <text className={"add " + (r.skipped ? "" : sgnCls(r.adds))} x={AX} y={cy + 4} textAnchor="end">
                      {r.skipped ? "0" : pts(r.adds).replace(" pts", "")}
                    </text>
                  </g>
                </g>
              );
            })}
            <line className="axis" x1={0} x2={W} y1={top + n * rh} y2={top + n * rh} />
            <text className="dname" x={NX} y={top + n * rh + 24}>
              {stock ? "All picks" : "All " + w.plural}
            </text>
            <text className="sval" x={BX} y={top + n * rh + 24}>
              {money(total.bought)} put in
            </text>
            <text className={"add tot " + sgnCls(total.adds)} x={AX} y={top + n * rh + 24} textAnchor="end">
              {pts(total.adds).replace(" pts", "")}
            </text>
          </svg>
        </div>
      </ChartSlot>
      {table && (
        <SkTable
          caption={stock ? `Each big pick vs its ${w.noun}'s index` : `Each ${w.noun} vs the whole market`}
          head={[stock ? "Pick" : w.Noun, "Share of their money", ...(stock ? [] : ["Market holds"]), stock ? "Stock, a year" : `${w.Noun} index, a year`, stock ? `${w.Noun} index, a year` : "Market, a year", "Beat by", "Adds, a year"]}
          rows={[
            ...rows.map((r) => [
              stock && !r.rest ? `${r.lab} (${r.sub})` : r.lab,
              share0(r.share),
              ...(stock ? [] : [r.mktShare == null ? "–" : share0(r.mktShare)]),
              pct(r.choice),
              pct(r.bench),
              r.skipped ? "–" : pts(r.beat),
              r.skipped ? "0" : pts(r.adds),
            ]),
            [stock ? "All picks" : "All " + w.plural, money(total.bought) + " put in", ...(stock ? [] : [""]), "", "", "", pts(total.adds)],
          ]}
        />
      )}
    </div>
  );
}
