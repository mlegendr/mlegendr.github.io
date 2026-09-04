"use client";

import * as React from "react";
import type { OverrideRecord, OverrideScope } from "@/lib/overrides";
import type { PoolSettings } from "@/lib/types";
import { TEAM_ABBRS } from "@/lib/teams";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Spinner, Switch } from "./ui";

interface Props {
  poolName: string;
  settings: PoolSettings;
  providers: Record<string, boolean>;
  overrides: OverrideRecord[];
  detectedWeek: number;
  manualInjuries: {
    id: number;
    week: number;
    team: string;
    playerName: string;
    position: string;
    status: string;
    impact: string;
  }[];
  games: { id: string; week: number; home: string; away: string }[];
}

const STATUSES = ["OUT", "DOUBTFUL", "QUESTIONABLE", "IR", "PUP", "PROBABLE", "ACTIVE"];
const POSITIONS = ["QB", "RB", "WR", "TE", "LT", "RT", "G", "C", "EDGE", "DT", "LB", "CB", "S", "K"];

export function SettingsForm(props: Props) {
  const [settings, setSettings] = React.useState(props.settings);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const patch = async (next: Partial<PoolSettings>) => {
    setSettings((s) => ({ ...s, ...next }));
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
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
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">Settings</h1>
        <span className="text-[11px] text-ink-500">
          {saving ? "Saving…" : saved ? `Saved at ${saved}` : `Pool: ${props.poolName}`}
        </span>
      </div>
      {error ? (
        <div className="rounded-lg border border-bad/40 bg-bad/5 p-3 text-sm text-bad">{error}</div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ------------------------------------------------- pool rules --- */}
        <Card>
          <CardHeader>
            <CardTitle>Pool rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="season">Season</Label>
                <Input
                  id="season"
                  className="mt-1"
                  value={settings.season}
                  onChange={(e) => setSettings((s) => ({ ...s, season: Number(e.target.value) }))}
                  onBlur={(e) => patch({ season: Number(e.target.value) })}
                  inputMode="numeric"
                />
                <p className="mt-1 text-[10px] text-ink-600">
                  Changing the season needs a re-seed: <code>npm run db:seed -- --season YYYY</code>
                </p>
              </div>
              <div>
                <Label htmlFor="weeks">Regular-season weeks</Label>
                <Input
                  id="weeks"
                  className="mt-1"
                  value={settings.totalRegularSeasonWeeks}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      totalRegularSeasonWeeks: Number(e.target.value),
                    }))
                  }
                  onBlur={(e) => patch({ totalRegularSeasonWeeks: Number(e.target.value) })}
                  inputMode="numeric"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="week-override">Current week override</Label>
              <div className="mt-1 flex items-center gap-2">
                <Select
                  id="week-override"
                  value={settings.currentWeekOverride ?? ""}
                  onChange={(e) =>
                    patch({
                      currentWeekOverride: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="">Auto — detected week {props.detectedWeek}</option>
                  {Array.from({ length: 22 }, (_, i) => i + 1).map((w) => (
                    <option key={w} value={w}>
                      Week {w}
                    </option>
                  ))}
                </Select>
                {settings.currentWeekOverride != null ? (
                  <Badge tone="violet">Manual override</Badge>
                ) : null}
              </div>
            </div>

            <ToggleRow
              label="A tie counts as a loss"
              hint="Most pools treat a tie as elimination. Turn this off if yours advances a tie."
              checked={settings.tieCountsAsLoss}
              onChange={(v) => patch({ tieCountsAsLoss: v })}
            />
            <ToggleRow
              label="Include postseason weeks"
              hint="Default is the 18-week regular season only."
              checked={settings.includePostseason}
              onChange={(v) => patch({ includePostseason: v })}
            />

            <div>
              <Label htmlFor="horizon">Default optimization horizon</Label>
              <Select
                id="horizon"
                className="mt-1"
                value={String(settings.defaultHorizon)}
                onChange={(e) => patch({ defaultHorizon: Number(e.target.value) || 6 })}
              >
                <option value="3">3 weeks</option>
                <option value="6">6 weeks (recommended)</option>
                <option value="9">9 weeks</option>
                <option value="18">Rest of season</option>
              </Select>
              <p className="mt-1 text-[10px] leading-relaxed text-ink-600">
                A medium horizon balances the no-repeat constraint against the genuine uncertainty
                of far-future forecasts. The season-long result is always shown alongside.
              </p>
            </div>

            <div>
              <Label htmlFor="risk">Risk preference ({settings.riskPreference.toFixed(2)})</Label>
              <input
                id="risk"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.riskPreference}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, riskPreference: Number(e.target.value) }))
                }
                onMouseUp={(e) =>
                  patch({ riskPreference: Number((e.target as HTMLInputElement).value) })
                }
                className="mt-2 w-full accent-[color:var(--color-accent)]"
              />
              <p className="mt-1 text-[10px] text-ink-600">
                0 = pure survival maximiser (default). Higher values only affect the optional Pool
                Strategy mode.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ---------------------------------------------------- providers - */}
        <Card>
          <CardHeader>
            <CardTitle>Data providers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              {Object.entries(props.providers)
                .filter(([k]) => k !== "offline")
                .map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between text-sm">
                    <span className="text-ink-300">{k}</span>
                    <Badge tone={v ? "good" : "neutral"}>{v ? "configured" : "not configured"}</Badge>
                  </div>
                ))}
            </div>

            <div className="rounded-lg border border-ink-700 bg-ink-850/50 p-3 text-[11px] leading-relaxed text-ink-400">
              <p className="font-semibold text-ink-200">API keys live in the environment only.</p>
              <p className="mt-1">
                They are read server-side and are never sent to the browser or stored in
                localStorage. Set them in <code className="text-ink-200">.env</code> and restart:
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-ink-950 p-2 text-[10px] text-ink-300">
{`ODDS_API_KEY="..."          # The Odds API
SPORTSDATAIO_API_KEY="..."  # SportsDataIO injuries
ENABLE_SLEEPER_FALLBACK="1"
ENABLE_WEATHER="1"`}
              </pre>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="odds-provider">Odds provider</Label>
                <Select
                  id="odds-provider"
                  className="mt-1 w-full"
                  value={settings.oddsProvider}
                  onChange={(e) =>
                    patch({ oddsProvider: e.target.value as PoolSettings["oddsProvider"] })
                  }
                >
                  <option value="auto">Auto (The Odds API, else reference line)</option>
                  <option value="the-odds-api">The Odds API only</option>
                  <option value="schedule-reference">Schedule reference line only</option>
                  <option value="manual">Manual entries only</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="injury-provider">Injury provider</Label>
                <Select
                  id="injury-provider"
                  className="mt-1 w-full"
                  value={settings.injuryProvider}
                  onChange={(e) =>
                    patch({ injuryProvider: e.target.value as PoolSettings["injuryProvider"] })
                  }
                >
                  <option value="auto">Auto (SportsDataIO, else Sleeper)</option>
                  <option value="sportsdataio">SportsDataIO only</option>
                  <option value="sleeper">Sleeper only</option>
                  <option value="manual">Manual entries only</option>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <ManualOverrides overrides={props.overrides} games={props.games} />
      <ManualInjuries injuries={props.manualInjuries} detectedWeek={props.detectedWeek} />
    </div>
  );
}

function ToggleRow({
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

/* ----------------------------------------------------- manual overrides -- */

function ManualOverrides({
  overrides,
  games,
}: {
  overrides: OverrideRecord[];
  games: { id: string; week: number; home: string; away: string }[];
}) {
  const [scope, setScope] = React.useState<OverrideScope>("WIN_PROBABILITY");
  const [team, setTeam] = React.useState("");
  const [week, setWeek] = React.useState("");
  const [gameId, setGameId] = React.useState("");
  const [probability, setProbability] = React.useState("");
  const [spread, setSpread] = React.useState("");
  const [homeMl, setHomeMl] = React.useState("");
  const [awayMl, setAwayMl] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const value: Record<string, unknown> =
        scope === "WIN_PROBABILITY"
          ? { probability: Number(probability) / 100 }
          : scope === "SPREAD"
            ? { spread: Number(spread) }
            : scope === "MONEYLINE"
              ? { home: Number(homeMl), away: Number(awayMl) }
              : { week: Number(week) };
      const res = await fetch("/api/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          team: team || null,
          week: week === "" ? null : Number(week),
          gameId: gameId || null,
          value,
          note: note || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save override");
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    await fetch(`/api/overrides?id=${id}`, { method: "DELETE" });
    window.location.reload();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual data overrides</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[11px] leading-relaxed text-ink-500">
          The app should never become unusable because an API is down. Every override below is
          reversible and is labelled <span className="text-violet">Manual Override</span> wherever
          the value is used.
        </p>

        <div className="grid gap-3 md:grid-cols-5">
          <div>
            <Label htmlFor="scope">Type</Label>
            <Select
              id="scope"
              className="mt-1 w-full"
              value={scope}
              onChange={(e) => setScope(e.target.value as OverrideScope)}
            >
              <option value="WIN_PROBABILITY">Win probability</option>
              <option value="SPREAD">Spread</option>
              <option value="MONEYLINE">Moneyline</option>
              <option value="CURRENT_WEEK">Current week</option>
            </Select>
          </div>

          {scope === "WIN_PROBABILITY" ? (
            <>
              <div>
                <Label htmlFor="ovr-team">Team</Label>
                <Select
                  id="ovr-team"
                  className="mt-1 w-full"
                  value={team}
                  onChange={(e) => setTeam(e.target.value)}
                >
                  <option value="">Select…</option>
                  {TEAM_ABBRS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="ovr-week">Week</Label>
                <Input
                  id="ovr-week"
                  className="mt-1"
                  value={week}
                  onChange={(e) => setWeek(e.target.value)}
                  inputMode="numeric"
                />
              </div>
              <div>
                <Label htmlFor="ovr-prob">Win probability %</Label>
                <Input
                  id="ovr-prob"
                  className="mt-1"
                  value={probability}
                  onChange={(e) => setProbability(e.target.value)}
                  placeholder="e.g. 72.5"
                  inputMode="decimal"
                />
              </div>
            </>
          ) : null}

          {scope === "SPREAD" || scope === "MONEYLINE" ? (
            <div className="md:col-span-2">
              <Label htmlFor="ovr-game">Game</Label>
              <Select
                id="ovr-game"
                className="mt-1 w-full"
                value={gameId}
                onChange={(e) => setGameId(e.target.value)}
              >
                <option value="">Select…</option>
                {games.map((g) => (
                  <option key={g.id} value={g.id}>
                    W{g.week} {g.away} @ {g.home}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {scope === "SPREAD" ? (
            <div>
              <Label htmlFor="ovr-spread">Spread (home)</Label>
              <Input
                id="ovr-spread"
                className="mt-1"
                value={spread}
                onChange={(e) => setSpread(e.target.value)}
                placeholder="-6.5"
                inputMode="decimal"
              />
            </div>
          ) : null}

          {scope === "MONEYLINE" ? (
            <>
              <div>
                <Label htmlFor="ovr-home-ml">Home ML</Label>
                <Input
                  id="ovr-home-ml"
                  className="mt-1"
                  value={homeMl}
                  onChange={(e) => setHomeMl(e.target.value)}
                  placeholder="-280"
                />
              </div>
              <div>
                <Label htmlFor="ovr-away-ml">Away ML</Label>
                <Input
                  id="ovr-away-ml"
                  className="mt-1"
                  value={awayMl}
                  onChange={(e) => setAwayMl(e.target.value)}
                  placeholder="+230"
                />
              </div>
            </>
          ) : null}

          {scope === "CURRENT_WEEK" ? (
            <div>
              <Label htmlFor="ovr-cw">Week</Label>
              <Input
                id="ovr-cw"
                className="mt-1"
                value={week}
                onChange={(e) => setWeek(e.target.value)}
                inputMode="numeric"
              />
            </div>
          ) : null}

          <div className="md:col-span-2">
            <Label htmlFor="ovr-note">Note</Label>
            <Input
              id="ovr-note"
              className="mt-1"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why you are overriding this"
            />
          </div>
        </div>

        {error ? <p className="text-xs text-bad">{error}</p> : null}
        <Button size="sm" variant="outline" onClick={submit} disabled={busy}>
          {busy ? <Spinner /> : null} Save override
        </Button>

        {overrides.length > 0 ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                <th className="py-1 text-left">Type</th>
                <th className="py-1 text-left">Target</th>
                <th className="py-1 text-left">Value</th>
                <th className="py-1 text-left">Note</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {overrides.map((o) => (
                <tr key={o.id} className="border-b border-ink-850/70">
                  <td className="py-1.5">
                    <Badge tone="violet">{o.scope}</Badge>
                  </td>
                  <td className="py-1.5 text-ink-300">
                    {[o.teamAbbr, o.week != null ? `W${o.week}` : null, o.gameId]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </td>
                  <td className="py-1.5 font-mono text-[10px] text-ink-400">
                    {JSON.stringify(o.value)}
                  </td>
                  <td className="py-1.5 text-ink-500">{o.note ?? "—"}</td>
                  <td className="py-1.5 text-right">
                    <Button size="sm" variant="ghost" onClick={() => remove(o.id)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-ink-600">No overrides active.</p>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------ manual injuries -- */

function ManualInjuries({
  injuries,
  detectedWeek,
}: {
  injuries: Props["manualInjuries"];
  detectedWeek: number;
}) {
  const [team, setTeam] = React.useState("");
  const [player, setPlayer] = React.useState("");
  const [position, setPosition] = React.useState("QB");
  const [status, setStatus] = React.useState("OUT");
  const [week, setWeek] = React.useState(String(detectedWeek));
  const [starter, setStarter] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/injuries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          team,
          playerName: player,
          position,
          status,
          week: Number(week),
          isStarter: starter,
          depthChartRank: starter ? 1 : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save injury");
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const remove = async (id: number) => {
    await fetch(`/api/injuries?id=${id}`, { method: "DELETE" });
    window.location.reload();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual injuries</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[11px] leading-relaxed text-ink-500">
          Enter anything the providers have not caught yet, e.g.{" "}
          <span className="text-ink-300">Josh Allen — OUT</span> or{" "}
          <span className="text-ink-300">starting LT — doubtful</span>. Manual entries supersede
          stale provider data for the same player.
        </p>

        <div className="grid gap-3 md:grid-cols-6">
          <div>
            <Label htmlFor="inj-team">Team</Label>
            <Select
              id="inj-team"
              className="mt-1 w-full"
              value={team}
              onChange={(e) => setTeam(e.target.value)}
            >
              <option value="">Select…</option>
              {TEAM_ABBRS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="inj-player">Player</Label>
            <Input
              id="inj-player"
              className="mt-1"
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              placeholder="Josh Allen"
            />
          </div>
          <div>
            <Label htmlFor="inj-pos">Position</Label>
            <Select
              id="inj-pos"
              className="mt-1 w-full"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
            >
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="inj-status">Status</Label>
            <Select
              id="inj-status"
              className="mt-1 w-full"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="inj-week">Week</Label>
            <Input
              id="inj-week"
              className="mt-1"
              value={week}
              onChange={(e) => setWeek(e.target.value)}
              inputMode="numeric"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Switch checked={starter} onCheckedChange={setStarter} id="inj-starter" />
          <label htmlFor="inj-starter" className="text-xs text-ink-300">
            This player is a starter (depth chart #1)
          </label>
        </div>

        {error ? <p className="text-xs text-bad">{error}</p> : null}
        <Button size="sm" variant="outline" onClick={submit} disabled={busy || !team || !player}>
          {busy ? <Spinner /> : null} Add manual injury
        </Button>

        {injuries.length > 0 ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                <th className="py-1 text-left">Week</th>
                <th className="py-1 text-left">Team</th>
                <th className="py-1 text-left">Player</th>
                <th className="py-1 text-left">Status</th>
                <th className="py-1 text-left">Impact</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {injuries.map((i) => (
                <tr key={i.id} className="border-b border-ink-850/70">
                  <td className="py-1.5 text-ink-400">W{i.week}</td>
                  <td className="py-1.5 text-ink-200">{i.team}</td>
                  <td className="py-1.5 text-ink-100">
                    {i.playerName} <span className="text-ink-500">({i.position})</span>
                  </td>
                  <td className="py-1.5 text-ink-300">{i.status}</td>
                  <td className="py-1.5">
                    <Badge
                      tone={
                        i.impact === "CRITICAL" ? "bad" : i.impact === "HIGH" ? "warn" : "neutral"
                      }
                    >
                      {i.impact}
                    </Badge>
                  </td>
                  <td className="py-1.5 text-right">
                    <Button size="sm" variant="ghost" onClick={() => remove(i.id)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-ink-600">No manual injuries entered.</p>
        )}
      </CardContent>
    </Card>
  );
}
