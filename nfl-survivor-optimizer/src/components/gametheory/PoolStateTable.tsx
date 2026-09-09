"use client";

import * as React from "react";
import type { EntryState, InventoryEdge } from "@/lib/gametheory/types";
import { TEAM_ABBRS, teamName } from "@/lib/teams";
import { cn } from "@/lib/ui";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from "../ui";

const STATUS_TONE = {
  ACTIVE: "good",
  ELIMINATED: "bad",
  UNKNOWN: "warn",
  WINNER: "accent",
} as const;

const PICK_TONE = {
  WIN: "border-good/50 bg-good/15 text-good",
  LOSS: "border-bad/50 bg-bad/15 text-bad",
  TIE: "border-warn/50 bg-warn/15 text-warn",
  PENDING: "border-accent/40 bg-accent/10 text-accent",
} as const;

export function PoolStateTable({
  entries,
  weeks,
  currentWeek,
  onSelect,
  selectedId,
  onRefresh,
}: {
  entries: EntryState[];
  weeks: number[];
  currentWeek: number;
  onSelect: (id: string) => void;
  selectedId: string | null;
  onRefresh: () => void;
}) {
  const [filter, setFilter] = React.useState("");
  const [showEliminated, setShowEliminated] = React.useState(true);

  const visible = entries.filter((s) => {
    if (!showEliminated && s.entry.status === "ELIMINATED") return false;
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      s.entry.displayName.toLowerCase().includes(q) ||
      (s.entry.ownerName ?? "").toLowerCase().includes(q)
    );
  });

  const active = entries.filter((s) => s.entry.status === "ACTIVE").length;
  const eliminated = entries.filter((s) => s.entry.status === "ELIMINATED").length;

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Pool state</CardTitle>
        <div className="flex items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter entries or owners…"
            className="h-8 w-52 text-xs"
          />
          <Button
            size="sm"
            variant={showEliminated ? "outline" : "ghost"}
            onClick={() => setShowEliminated((v) => !v)}
          >
            {showEliminated ? "Hide" : "Show"} eliminated ({eliminated})
          </Button>
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-3">
        <div className="flex flex-wrap gap-x-8 gap-y-2 px-5 pb-3 text-sm">
          <Stat label="Original entries" value={entries.length} />
          <Stat label="Entries remaining" value={active} tone="good" />
          <Stat label="Entries eliminated" value={eliminated} tone={eliminated ? "bad" : undefined} />
          <Stat label="Current week" value={currentWeek} />
        </div>

        <div className="scroll-x">
          <table className="w-full min-w-[900px] border-collapse text-sm">
            <thead>
              <tr className="border-y border-ink-800 text-[10px] uppercase tracking-wider text-ink-400">
                <th className="px-4 py-2 text-left font-semibold">Entry</th>
                <th className="px-2 py-2 text-left font-semibold">Owner</th>
                <th className="px-2 py-2 text-left font-semibold">Status</th>
                {weeks.map((w) => (
                  <th
                    key={w}
                    className={cn(
                      "w-12 px-1 py-2 text-center font-semibold",
                      w === currentWeek ? "text-accent" : "",
                    )}
                  >
                    W{w}
                  </th>
                ))}
                <th className="px-2 py-2 text-right font-semibold">Used</th>
                <th className="px-2 py-2 text-right font-semibold">Left</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const isSelected = s.entry.id === selectedId;
                return (
                  <tr
                    key={s.entry.id}
                    onClick={() => onSelect(s.entry.id)}
                    className={cn(
                      "cursor-pointer border-b border-ink-850 transition-colors hover:bg-ink-850/60",
                      isSelected && "bg-accent/[0.08]",
                      s.entry.status === "ELIMINATED" && "opacity-55",
                    )}
                  >
                    <td className="px-4 py-2">
                      <span className="font-semibold text-ink-100">{s.entry.displayName}</span>
                      {s.entry.isUser ? (
                        <Badge tone="accent" className="ml-2">
                          You
                        </Badge>
                      ) : null}
                      {s.entry.manualStatusOverride ? (
                        <Badge tone="violet" className="ml-2">
                          Manual override
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-xs text-ink-400">{s.entry.ownerName ?? "—"}</td>
                    <td className="px-2 py-2">
                      <Badge tone={STATUS_TONE[s.entry.status]}>{s.entry.status}</Badge>
                      {s.entry.eliminatedWeek != null ? (
                        <span className="ml-1.5 text-[10px] text-ink-500">W{s.entry.eliminatedWeek}</span>
                      ) : null}
                    </td>
                    {weeks.map((w) => {
                      const pick = s.picks.find((p) => p.week === w);
                      if (!pick) {
                        return (
                          <td key={w} className="px-1 py-2 text-center text-[10px] text-ink-700">
                            ·
                          </td>
                        );
                      }
                      return (
                        <td key={w} className="px-1 py-2 text-center">
                          <span
                            className={cn(
                              "inline-block rounded border px-1 py-0.5 text-[10px] font-semibold",
                              PICK_TONE[pick.pickStatus],
                              w === currentWeek && "ring-1 ring-accent/50",
                            )}
                            title={`${teamName(pick.team)} — ${pick.pickStatus}`}
                          >
                            {pick.team}
                          </span>
                        </td>
                      );
                    })}
                    <td className="tabular px-2 py-2 text-right text-ink-300">{s.usedTeams.length}</td>
                    <td className="tabular px-2 py-2 text-right text-ink-300">
                      {s.entry.status === "ELIMINATED" ? "—" : TEAM_ABBRS.length - s.usedTeams.length}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {visible.some((s) => s.entry.eliminationReason) ? (
          <div className="mt-3 space-y-1 px-5 text-[11px] text-ink-400">
            {visible
              .filter((s) => s.entry.eliminationReason)
              .map((s) => (
                <div key={s.entry.id}>
                  <span className="font-semibold text-ink-300">{s.entry.displayName}</span>{" "}
                  <span className="text-bad">ELIMINATED — Week {s.entry.eliminatedWeek}.</span>{" "}
                  {s.entry.eliminationReason}
                </div>
              ))}
          </div>
        ) : null}

        <p className="px-5 pt-3 text-[11px] leading-relaxed text-ink-500">
          Click any entry to inspect exactly which teams it can still use. Entries owned by the same
          person are listed separately and never share inventory.
        </p>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "bad";
}) {
  return (
    <span>
      <span className="text-ink-500">{label} </span>
      <span
        className={cn(
          "tabular font-semibold",
          tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink-100",
        )}
      >
        {value}
      </span>
    </span>
  );
}

export function InventoryEdgeTable({ edges }: { edges: InventoryEdge[] }) {
  const sorted = [...edges].sort(
    (a, b) => Number(b.userHasTeam) - Number(a.userHasTeam) || a.opponentAccessRate - b.opponentAccessRate,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Team-level inventory advantage</CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="scroll-x">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-y border-ink-800 text-[10px] uppercase tracking-wider text-ink-400">
                <th className="px-5 py-2 text-left font-semibold">Team</th>
                <th className="px-2 py-2 text-left font-semibold">You</th>
                <th className="px-2 py-2 text-right font-semibold">Opposing entries with team</th>
                <th className="px-2 py-2 text-right font-semibold">Access rate</th>
                <th className="px-5 py-2 text-left font-semibold">Scarcity</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => (
                <tr key={e.team} className="border-b border-ink-850/70">
                  <td className="px-5 py-1.5 font-semibold text-ink-100">{e.team}</td>
                  <td className="px-2 py-1.5">
                    <Badge tone={e.userHasTeam ? "good" : "neutral"}>
                      {e.userHasTeam ? "YES" : "USED"}
                    </Badge>
                  </td>
                  <td className="tabular px-2 py-1.5 text-right text-ink-300">
                    {e.opponentsWithTeam}/{e.activeOpponents}
                  </td>
                  <td className="tabular px-2 py-1.5 text-right text-ink-200">
                    {(e.opponentAccessRate * 100).toFixed(0)}%
                  </td>
                  <td className="px-5 py-1.5">
                    <Badge
                      tone={
                        e.scarcity === "EXCLUSIVE"
                          ? "violet"
                          : e.scarcity === "SCARCE"
                            ? "accent"
                            : "neutral"
                      }
                    >
                      {e.scarcity}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
