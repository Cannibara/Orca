import { useEffect, useState } from "react";
import { loadFunds, loadHome, loadSectorScores, loadSkill, type Stock } from "../data/api";
import type { FundsIndex, SectorScores, Skill, TopRow } from "../data/types";
import type { Load } from "../lib/useLoad";
import { DecisionsPanel } from "./DecisionsPanel";
import { MixPanel } from "./MixPanel";
import type { Tier } from "./skill";
import { SkillMapPanel, type MapView } from "./SkillMapPanel";
import "./skill.css";
import { StackedPanel } from "./StackedPanel";

// The Specialization tab: the sector choice vs stock choice panels (spec 2026-11-21 §5; owner 2026-11-22: their
// own tab, after Analysis). They need fund/{id}/skill.json, which only scored funds have.

/**
 * The production build sets VITE_SPECIALIZATION=hold while the published sector files are wrong (2026-11-23: one
 * stock's bad market value swings Orca's market index). The tab then says so, and its files are not loaded.
 */
export const SPECIALIZATION_HOLD = import.meta.env.VITE_SPECIALIZATION === "hold";

export type SkillData = { skill: Skill; scores: SectorScores | null; famous: TopRow[] | undefined; funds: FundsIndex | null };

export async function loadSkillData(id: number): Promise<SkillData | null> {
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

/**
 * The fund's sector data, loaded the first time the Specialization tab opens (and kept for later visits).
 * `ready` is data already loaded (a fund opened from another's map), shown from the first frame.
 */
export function useSkillData(id: number, open: boolean, ready?: SkillData | null): Load<SkillData | null> | null {
  const [state, setState] = useState<Load<SkillData | null> | null>(() => (ready !== undefined ? { status: "ready", data: ready } : null));
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

/**
 * The Specialization tab: the map, the stacked graph, the mix and the decisions, in that order. A fund the sector
 * step has not scored (no file) gets a note instead; a failed load says so.
 */
export function SpecializationTab({
  state,
  tier,
  onTier,
  fundId,
  name,
  stocks,
  view,
  onPeer,
}: {
  state: Load<SkillData | null> | null;
  tier: Tier;
  onTier: (t: Tier) => void;
  fundId: number;
  name: string;
  stocks: Map<number, Stock>;
  /** The map's comparison list and path to start with (kept from the fund this page was opened from). */
  view?: MapView;
  /** A click on a peer's dot: open that fund here. */
  onPeer?: (id: number, view: MapView) => void;
}) {
  if (SPECIALIZATION_HOLD) {
    return (
      <div className="state">
        <h4>Being checked</h4>
        <p>
          This tab will show how much of the fund's return came from the sectors it chose and how much from the stocks it picked inside them. We
          found an error in the market figures it compares against and are fixing it. It will be back soon.
        </p>
      </div>
    );
  }
  if (state === null || state.status === "loading") {
    return (
      <>
        <Skeleton title="What kind of investor?" />
        <Skeleton title="Annual return stacked graph" />
      </>
    );
  }
  if (state.status === "error") {
    return (
      <div className="state err" role="alert">
        <h4>Couldn't load this tab</h4>
        <p>Check your connection and reload the page.</p>
      </div>
    );
  }
  const d = state.data;
  if (!d) {
    return (
      <div className="state">
        <h4>Not scored yet</h4>
        <p>
          This tab shows how much of the fund's return came from the sectors it chose and how much from the stocks it picked inside them. Orca has not
          scored this fund yet: it needs trades it can replay in each stock's sector index.
        </p>
      </div>
    );
  }
  return (
    <>
      <SkillMapPanel
        fundId={fundId}
        name={name}
        skill={d.skill}
        tier={tier}
        onTier={onTier}
        scores={d.scores}
        famous={d.famous}
        funds={d.funds}
        view={view}
        onPeer={onPeer}
      />
      <StackedPanel skill={d.skill} tier={tier} />
      <MixPanel skill={d.skill} />
      <DecisionsPanel skill={d.skill} tier={tier} stocks={stocks} />
    </>
  );
}
