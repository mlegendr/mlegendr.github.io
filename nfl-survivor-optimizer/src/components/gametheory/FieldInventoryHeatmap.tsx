"use client";

import * as React from "react";
import type { EntryState } from "@/lib/gametheory/types";
import { TEAM_ABBRS } from "@/lib/teams";
import { cn } from "@/lib/ui";
import { Button, Card, CardContent, CardHeader, CardTitle } from "../ui";

/**
 * §23 — rows are pool entries, columns are the 32 NFL teams, and each cell says
 * whether that entry can still use that team. Inventory asymmetry is the whole
 * point of the picture, so the user's row is pinned to the top.
 */
export function FieldInventoryHeatmap({ entries }: { entries: EntryState[] }) {
  const [showEliminated, setShowEliminated] = React.useState(false);

  const active = entries.filter((s) => s.entry.status === "ACTIVE");
  const eliminated = entries.filter((s) => s.entry.status !== "ACTIVE");
  const rows = showEliminated ? [...active, ...eliminated] : active;

  const activeOpponents = active.filter((s) => !s.entry.isUser);
  const availability = new Map(
    TEAM_ABBRS.map((team) => [
      team,
      activeOpponents.length === 0
        ? 0
        : activeOpponents.filter((s) => !s.usedTeams.includes(team)).length /
          activeOpponents.length,
    ]),
  );

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Field inventory — who can still use which team</CardTitle>
        <Button
          size="sm"
          variant={showEliminated ? "outline" : "ghost"}
          onClick={() => setShowEliminated((v) => !v)}
        >
          {showEliminated ? "Hide" : "Show"} eliminated ({eliminated.length})
        </Button>
      </CardHeader>
      <CardContent className="px-0">
        <div className="scroll-x px-5">
          <table className="border-separate border-spacing-[2px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-ink-900 pr-2 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                  Entry
                </th>
                {TEAM_ABBRS.map((t) => (
                  <th
                    key={t}
                    className="w-8 text-center text-[9px] font-semibold text-ink-500"
                    style={{ writingMode: "vertical-rl" }}
                  >
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const used = new Set(s.usedTeams);
                const dead = s.entry.status !== "ACTIVE";
                return (
                  <tr key={s.entry.id}>
                    <td
                      className={cn(
                        "sticky left-0 z-10 whitespace-nowrap bg-ink-900 pr-3 text-[11px] font-semibold",
                        s.entry.isUser ? "text-accent" : dead ? "text-ink-600" : "text-ink-200",
                        dead && "line-through decoration-ink-700",
                      )}
                    >
                      {s.entry.displayName}
                      {s.entry.ownerName ? (
                        <span className="ml-1 font-normal text-ink-600">({s.entry.ownerName})</span>
                      ) : null}
                    </td>
                    {TEAM_ABBRS.map((t) => {
                      const isUsed = used.has(t);
                      return (
                        <td key={t} className="p-0">
                          <div
                            title={`${s.entry.displayName} — ${t}: ${isUsed ? "USED" : "AVAILABLE"}`}
                            className={cn(
                              "h-5 w-8 rounded",
                              dead
                                ? "bg-ink-850 opacity-40"
                                : isUsed
                                  ? "bg-ink-700"
                                  : s.entry.isUser
                                    ? "bg-accent/60"
                                    : "bg-good/35",
                            )}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              <tr>
                <td className="sticky left-0 z-10 bg-ink-900 pr-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                  % opponents with team
                </td>
                {TEAM_ABBRS.map((t) => {
                  const rate = availability.get(t) ?? 0;
                  return (
                    <td key={t} className="p-0 pt-2">
                      <div
                        className="tabular grid h-5 w-8 place-items-center rounded text-[9px] font-bold"
                        style={{
                          background: `rgba(98,182,255,${0.12 + rate * 0.5})`,
                          color: rate > 0.6 ? "#0c1018" : "#cbd5e1",
                        }}
                        title={`${t}: ${(rate * 100).toFixed(0)}% of active opposing entries still hold it`}
                      >
                        {Math.round(rate * 100)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-800 px-5 pt-3 text-[11px] text-ink-400">
          <span className="flex items-center gap-1.5">
            <span className="h-4 w-6 rounded bg-accent/60" /> available to you
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-4 w-6 rounded bg-good/35" /> available to an opponent
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-4 w-6 rounded bg-ink-700" /> already used
          </span>
          <span>
            A team you hold that few opponents still have is where inventory advantage comes from.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
