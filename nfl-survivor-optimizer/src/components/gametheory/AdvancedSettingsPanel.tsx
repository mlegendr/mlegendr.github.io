"use client";

import * as React from "react";
import type { AllLoseRule, GameTheorySettings, PoolObjective } from "@/lib/gametheory/types";
import { OBJECTIVE_LABEL } from "@/lib/gametheory/types";
import { TEAM_ABBRS } from "@/lib/teams";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Spinner, Switch } from "../ui";

/** §45 — every opponent-model and tournament parameter, visible and editable. */
export function AdvancedSettingsPanel({ initial }: { initial: GameTheorySettings | null }) {
  const [settings, setSettings] = React.useState<GameTheorySettings | null>(initial);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [popularityTeam, setPopularityTeam] = React.useState("");
  const [popularityValue, setPopularityValue] = React.useState("");

  React.useEffect(() => {
    if (initial) setSettings(initial);
  }, [initial]);

  const load = React.useCallback(async () => {
    const res = await fetch("/api/pool-equity/settings", { cache: "no-store" });
    const json = await res.json();
    if (res.ok) setSettings(json.settings);
  }, []);

  React.useEffect(() => {
    if (open && !settings) void load();
  }, [open, settings, load]);

  const patch = async (next: Partial<GameTheorySettings>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pool-equity/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setSettings(json.settings);
      setSaved(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Advanced pool-equity settings</CardTitle>
        <span className="flex items-center gap-2">
          {busy ? <Spinner /> : null}
          {saved ? <span className="text-[11px] text-ink-500">Saved {saved}</span> : null}
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Show"}
          </Button>
        </span>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-5">
          {error ? <p className="text-xs text-bad">{error}</p> : null}
          {!settings ? (
            <p className="text-xs text-ink-500">Loading…</p>
          ) : (
            <>
              <section className="space-y-3">
                <SectionTitle>Optimization objective</SectionTitle>
                <Select
                  value={settings.objective}
                  onChange={(e) => patch({ objective: e.target.value as PoolObjective })}
                  className="w-full"
                >
                  {(Object.keys(OBJECTIVE_LABEL) as PoolObjective[]).map((o) => (
                    <option key={o} value={o}>
                      {OBJECTIVE_LABEL[o]}
                    </option>
                  ))}
                </Select>
                <p className="text-[10px] leading-relaxed text-ink-600">
                  Expected prize equity is the default because most pools split a shared win. If
                  your pool plays on until exactly one entry remains, tick the rule below and the
                  objective is reported as pool win probability instead — with that rule the two are
                  the same thing.
                </p>
              </section>

              <section className="grid gap-3 sm:grid-cols-3">
                <div>
                  <Label htmlFor="sims">Monte Carlo simulations</Label>
                  <Input
                    id="sims"
                    className="mt-1"
                    defaultValue={settings.simulations}
                    onBlur={(e) => patch({ simulations: Number(e.target.value) })}
                    inputMode="numeric"
                  />
                </div>
                <div>
                  <Label htmlFor="seed">Random seed</Label>
                  <Input
                    id="seed"
                    className="mt-1"
                    defaultValue={settings.seed}
                    onBlur={(e) => patch({ seed: Number(e.target.value) })}
                    inputMode="numeric"
                  />
                </div>
                <div>
                  <Label htmlFor="mode">Behaviour model</Label>
                  <Select
                    id="mode"
                    className="mt-1 w-full"
                    value={settings.behaviorMode}
                    onChange={(e) =>
                      patch({ behaviorMode: e.target.value as GameTheorySettings["behaviorMode"] })
                    }
                  >
                    <option value="LEARNED">Learned (pool + entry deviations)</option>
                    <option value="POOL_AVERAGE">Pool average only</option>
                    <option value="COLD_START">Cold-start priors only</option>
                  </Select>
                </div>
              </section>

              <section className="grid gap-4 sm:grid-cols-2">
                <Slider
                  id="temp"
                  label={`Opponent temperature (${settings.opponentTemperature.toFixed(2)})`}
                  hint="Higher makes opposing entries less predictable."
                  min={0.2}
                  max={4}
                  step={0.05}
                  value={settings.opponentTemperature}
                  onCommit={(v) => patch({ opponentTemperature: v })}
                />
                <Slider
                  id="shrink"
                  label={`Entry shrinkage strength (${settings.entryShrinkageStrength.toFixed(1)})`}
                  hint="Higher keeps entries closer to pool-average behaviour."
                  min={0}
                  max={30}
                  step={0.5}
                  value={settings.entryShrinkageStrength}
                  onCommit={(v) => patch({ entryShrinkageStrength: v })}
                />
                <Slider
                  id="pop"
                  label={`Public-popularity weight (${settings.publicPopularityWeight.toFixed(2)})`}
                  hint="How much national ownership influences the opponent model."
                  min={0}
                  max={3}
                  step={0.05}
                  value={settings.publicPopularityWeight}
                  onCommit={(v) => patch({ publicPopularityWeight: v })}
                />
                <Slider
                  id="fv"
                  label={`Future-value weight (${settings.futureValueWeight.toFixed(2)})`}
                  hint="How much opposing entries are assumed to preserve valuable teams."
                  min={0}
                  max={3}
                  step={0.05}
                  value={settings.futureValueWeight}
                  onCommit={(v) => patch({ futureValueWeight: v })}
                />
              </section>

              <section className="space-y-3">
                <SectionTitle>Pool rules</SectionTitle>
                <Toggle
                  label="Play continues until exactly one entry remains"
                  hint="With this on there are no shared prizes, so the objective is reported as pool win probability."
                  checked={settings.rules.continueUntilOneRemains}
                  onChange={(v) => patch({ rules: { ...settings.rules, continueUntilOneRemains: v } })}
                />
                <Toggle
                  label="A tie counts as a loss"
                  hint="Mirrors the pool rule on the main Settings page."
                  checked={settings.rules.tieCountsAsLoss}
                  onChange={(v) => patch({ rules: { ...settings.rules, tieCountsAsLoss: v } })}
                />
                <Toggle
                  label="Winners split the prize equally"
                  hint="Turn off only if your pool awards the full prize to every co-winner."
                  checked={settings.rules.splitPrizeEqually}
                  onChange={(v) => patch({ rules: { ...settings.rules, splitPrizeEqually: v } })}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="alllose">If every remaining entry loses in one week</Label>
                    <Select
                      id="alllose"
                      className="mt-1 w-full"
                      value={settings.rules.allLoseRule}
                      onChange={(e) =>
                        patch({
                          rules: { ...settings.rules, allLoseRule: e.target.value as AllLoseRule },
                        })
                      }
                    >
                      <option value="SHARE_AMONG_LAST">Last remaining group shares the prize</option>
                      <option value="REINSTATE_ALL">All are reinstated and play continues</option>
                      <option value="POOL_ENDS_NO_WINNER">Pool ends with no winner</option>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="tieprob">NFL tie probability per game</Label>
                    <Input
                      id="tieprob"
                      className="mt-1"
                      defaultValue={settings.rules.tieProbability}
                      onBlur={(e) =>
                        patch({
                          rules: { ...settings.rules, tieProbability: Number(e.target.value) },
                        })
                      }
                      inputMode="decimal"
                    />
                    <p className="mt-1 text-[10px] text-ink-600">
                      Historically about 0.002. Set to 0 to ignore ties entirely.
                    </p>
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <SectionTitle>Public pick popularity (optional, manual)</SectionTitle>
                <p className="text-[10px] leading-relaxed text-ink-600">
                  National survivor ownership, if you have a reliable source. It is only a prior:
                  your pool&apos;s actual entry inventories always take precedence, so a team 40% of
                  the country is picking cannot reach 40% here if most of your rivals have already
                  used it. This app will not scrape it.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <Select
                    value={popularityTeam}
                    onChange={(e) => setPopularityTeam(e.target.value)}
                    className="h-8 text-xs"
                  >
                    <option value="">Team…</option>
                    {TEAM_ABBRS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                  <Input
                    value={popularityValue}
                    onChange={(e) => setPopularityValue(e.target.value)}
                    placeholder="% e.g. 40"
                    className="h-8 w-28 text-xs"
                    inputMode="decimal"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!popularityTeam || !popularityValue}
                    onClick={() => {
                      const v = Number(popularityValue) / 100;
                      patch({
                        publicPopularity: { ...settings.publicPopularity, [popularityTeam]: v },
                      });
                      setPopularityTeam("");
                      setPopularityValue("");
                    }}
                  >
                    Set
                  </Button>
                  {Object.keys(settings.publicPopularity).length > 0 ? (
                    <Button size="sm" variant="ghost" onClick={() => patch({ publicPopularity: {} })}>
                      Clear all
                    </Button>
                  ) : null}
                </div>
                {Object.keys(settings.publicPopularity).length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    {Object.entries(settings.publicPopularity).map(([t, v]) => (
                      <span
                        key={t}
                        className="rounded border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-ink-300"
                      >
                        {t} {(v * 100).toFixed(0)}%
                      </span>
                    ))}
                  </div>
                ) : null}
              </section>

              <section className="grid gap-4 sm:grid-cols-2">
                <SectionTitle className="sm:col-span-2">User rollout policy</SectionTitle>
                <Slider
                  id="rollfv"
                  label={`Rollout future-value weight (${settings.rolloutFutureValueWeight.toFixed(2)})`}
                  hint="How much your simulated future self preserves valuable teams."
                  min={0}
                  max={3}
                  step={0.05}
                  value={settings.rolloutFutureValueWeight}
                  onCommit={(v) => patch({ rolloutFutureValueWeight: v })}
                />
                <Slider
                  id="rolldiff"
                  label={`Rollout differentiation weight (${settings.rolloutDifferentiationWeight.toFixed(2)})`}
                  hint="How much your simulated future self avoids heavily-owned teams."
                  min={0}
                  max={2}
                  step={0.05}
                  value={settings.rolloutDifferentiationWeight}
                  onCommit={(v) => patch({ rolloutDifferentiationWeight: v })}
                />
              </section>
            </>
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-300 ${className ?? ""}`}>
      {children}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm text-ink-200">{label}</div>
        <div className="text-[11px] leading-relaxed text-ink-500">{hint}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function Slider({
  id,
  label,
  hint,
  min,
  max,
  step,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={() => onCommit(local)}
        onTouchEnd={() => onCommit(local)}
        className="mt-2 w-full accent-[color:var(--color-accent)]"
      />
      <p className="mt-0.5 text-[10px] text-ink-600">{hint}</p>
    </div>
  );
}
