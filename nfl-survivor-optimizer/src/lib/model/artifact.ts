/**
 * Loading of the trained model artifact produced by `scripts/train_model.py`.
 *
 * The artifact is a small JSON file (coefficients, Elo hyper-parameters and
 * per-team preseason priors) checked into `data/model/model.json`. Keeping it as
 * data rather than code means retraining is `npm run train` with no rebuild, and
 * the app degrades to a documented default artifact if the file is absent.
 */

import "../server-guard";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ModelArtifact {
  version: number;
  trainedAt: string;
  targetSeason: number;
  trainSeasons: number[];
  holdoutSeasons: number[];
  elo: {
    k: number;
    homeField: number;
    restPerDay: number;
    movScale: number;
    revert: number;
    base: number;
  };
  epa: { alpha: number; carryover: number; rampGames: number; scale: number };
  logistic: {
    featureOrder: string[];
    intercept: number;
    coefficients: Record<string, number>;
  };
  priors: Record<string, { elo: number; offEpa: number; defEpa: number }>;
  blend: {
    marketWeightBase: number;
    marketWeightPerBook: number;
    marketWeightMax: number;
    marketWeightMin: number;
    stalenessHalfLifeHours: number;
    singleBookPenalty: number;
  };
  horizonShrink: { perWeek: number; max: number };
  metrics?: unknown;
  /** True when we are running on the built-in fallback rather than a trained file. */
  isFallback?: boolean;
}

/**
 * Documented fallback used when `data/model/model.json` is missing.
 * The numbers are the historically stable NFL defaults (Elo k=20, ~48 Elo points
 * of home-field, a 0.28 between-season regression) with flat priors — good enough
 * to be useful, and clearly labelled as untrained in the Data Status panel.
 */
export const FALLBACK_ARTIFACT: ModelArtifact = {
  version: 0,
  trainedAt: "1970-01-01T00:00:00.000Z",
  targetSeason: 2026,
  trainSeasons: [],
  holdoutSeasons: [],
  elo: { k: 20, homeField: 48, restPerDay: 1.6, movScale: 0.001, revert: 0.28, base: 1500 },
  epa: { alpha: 0.22, carryover: 0.55, rampGames: 4, scale: 10 },
  logistic: {
    featureOrder: ["eloDiff100", "epaEdge", "restDiff7", "neutralSite", "divisionGame"],
    intercept: 0,
    coefficients: {
      eloDiff100: 0.52,
      epaEdge: 0.15,
      restDiff7: 0.02,
      neutralSite: -0.1,
      divisionGame: -0.05,
    },
  },
  priors: {},
  blend: {
    marketWeightBase: 0.78,
    marketWeightPerBook: 0.022,
    marketWeightMax: 0.92,
    marketWeightMin: 0.3,
    stalenessHalfLifeHours: 36,
    singleBookPenalty: 0.35,
  },
  horizonShrink: { perWeek: 0.022, max: 0.34 },
  isFallback: true,
};

let cache: { artifact: ModelArtifact; loadedAt: number } | null = null;

export function modelArtifactPath(): string {
  return path.join(process.cwd(), "data", "model", "model.json");
}

export async function loadModelArtifact(force = false): Promise<ModelArtifact> {
  if (!force && cache && Date.now() - cache.loadedAt < 60_000) return cache.artifact;
  try {
    const raw = await readFile(modelArtifactPath(), "utf8");
    const parsed = JSON.parse(raw) as ModelArtifact;
    if (!parsed.logistic?.coefficients) throw new Error("malformed artifact");
    const artifact: ModelArtifact = { ...FALLBACK_ARTIFACT, ...parsed, isFallback: false };
    cache = { artifact, loadedAt: Date.now() };
    return artifact;
  } catch {
    cache = { artifact: FALLBACK_ARTIFACT, loadedAt: Date.now() };
    return FALLBACK_ARTIFACT;
  }
}

export function clearArtifactCache(): void {
  cache = null;
}
