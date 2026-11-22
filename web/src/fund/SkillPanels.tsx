import { useEffect, useState } from "react";
import { loadFunds, loadHome, loadSectorScores, loadSkill, type Stock } from "../data/api";
import type { FundsIndex, SectorScores, Skill, TopRow } from "../data/types";
import type { Load } from "../lib/useLoad";
import { DecisionsPanel } from "./DecisionsPanel";
import { MixPanel } from "./MixPanel";
import type { Tier } from "./skill";
import { SkillMapPanel } from "./SkillMapPanel";
import "./skill.css";
import { StackedPanel } from "./StackedPanel";

// The Analysis tab's sector choice vs stock choice panels (spec 2026-11-21 §5): the map at the top of the tab,
// then (after the key figures) the stacked graph, the mix and the decisions. They need fund/{id}/skill.json,
// which only scored funds have: without it the panels are absent and the tab is as it was.

export type SkillData = { skill: Skill; scores: SectorScores | null; famous: TopRow[] | undefined; funds: FundsIndex | null };

async function loadSkillData(id: number): Promise<SkillData | null> {
  const skill = await loadSkill(id);
  if (!skill) return null;
  // The map's peers; without them it still places this fund (and says so in its sentence).
  const [scores, famous, funds] = await Promise.all([
    loadSectorScores().catch(() => null),
    loadHome("top_max")
      .then((t) => t.famous)
      .catch(() => undefined),
    loadFunds().catch(() => null),
  ]);
  return { skill, scores, famous, funds };
}

/** The fund's sector data, loaded the first time the Analysis tab opens (and kept for later visits). */
export function useSkillData(id: number, open: boolean): Load<SkillData | null> | null {
  const [state, setState] = useState<Load<SkillData | null> | null>(null);
  const wanted = open || state !== null;
  useEffect(() => {
    if (!wanted || state !== null) return;
    let current = true;
    setState({ status: "loading" });
    loadSkillData(id).then(
      (data) => current && setState({ status: "ready", data }),
      (error: unknown) => current && setState({ status: "error", error }),
    );
    return () => {
      current = false;
    };
    // `state` is set here; only the first opening loads.
  }, [id, wanted]);
  return state;
}

function Skeleton({ title }: { title: string }) {
  return (
    <section className="panel skp sk-panel" aria-busy="true" aria-label={title + ", loading"}>
      <div className="ph">
        <div className="ph-t">
          <h3 className="pt">{title}</h3>
        </div>
      </div>
      <div className="pb">
        <span className="sk" style={{ height: 14, width: "60%" }} />
        <div className="skbars" aria-hidden="true">
          {[40, 70, 55, 90, 65, 80, 50].map((h, i) => (
            <span key={i} className="sk" style={{ height: h + "%" }} />
          ))}
        </div>
      </div>
    </section>
  );
}

type Shared = { state: Load<SkillData | null> | null; tier: Tier };

/** The map, at the top of the tab. */
export function SkillTop({ state, tier, onTier, fundId, name }: Shared & { onTier: (t: Tier) => void; fundId: number; name: string }) {
  if (state === null || state.status === "error") return null;
  if (state.status === "loading") return <Skeleton title="What kind of investor?" />;
  const d = state.data;
  if (!d) return null;
  return <SkillMapPanel fundId={fundId} name={name} skill={d.skill} tier={tier} onTier={onTier} scores={d.scores} famous={d.famous} funds={d.funds} />;
}

/** The stacked graph, the mix and the decisions, after the key figures. */
export function SkillBody({ state, tier, stocks }: Shared & { stocks: Map<number, Stock> }) {
  if (state === null || state.status === "error") return null;
  if (state.status === "loading") return <Skeleton title="Annual return stacked graph" />;
  const d = state.data;
  if (!d) return null;
  return (
    <>
      <StackedPanel skill={d.skill} tier={tier} />
      <MixPanel skill={d.skill} />
      <DecisionsPanel skill={d.skill} tier={tier} stocks={stocks} />
    </>
  );
}
