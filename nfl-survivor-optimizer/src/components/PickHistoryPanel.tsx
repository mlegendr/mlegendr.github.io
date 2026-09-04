"use client";

import * as React from "react";
import type { AnalysisSnapshot } from "@/lib/engine";
import { teamName } from "@/lib/teams";
import { pct } from "@/lib/ui";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from "./ui";

export function PickHistoryPanel({
  snapshot,
  busy,
  onDelete,
}: {
  snapshot: AnalysisSnapshot;
  busy: string | null;
  onDelete: (week: number) => void;
}) {
  const [confirmWeek, setConfirmWeek] = React.useState<number | null>(null);
  const picks = [...snapshot.picks].sort((a, b) => a.week - b.week);

  const download = async () => {
    const res = await fetch("/api/pool/export");
    const json = await res.json();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `survivor-pool-${snapshot.season}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const upload = async (file: File) => {
    const text = await file.text();
    await fetch("/api/pool/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
    });
    window.location.reload();
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Pick history</CardTitle>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={download}>
            Export JSON
          </Button>
          <label className="cursor-pointer rounded-lg px-3 py-1 text-xs font-medium text-ink-300 hover:bg-ink-800 hover:text-ink-100">
            Import JSON
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {picks.length === 0 ? (
          <p className="text-xs text-ink-500">
            No picks recorded yet. Confirming a pick writes it to the local database, so it
            survives a browser or server restart.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                <th className="px-1 py-1.5 text-left">Week</th>
                <th className="px-1 py-1.5 text-left">Team</th>
                <th className="px-1 py-1.5 text-left">Opponent</th>
                <th className="px-1 py-1.5 text-left">Status</th>
                <th className="px-1 py-1.5 text-right">Result</th>
                <th className="px-1 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {picks.map((p) => (
                <tr key={p.id} className="border-b border-ink-850/70">
                  <td className="tabular px-1 py-2 text-ink-400">W{p.week}</td>
                  <td className="px-1 py-2 font-semibold text-ink-100">{teamName(p.team)}</td>
                  <td className="px-1 py-2 text-xs text-ink-400">{p.opponent ?? "—"}</td>
                  <td className="px-1 py-2">
                    {p.confirmed ? (
                      <Badge tone="accent">Confirmed</Badge>
                    ) : (
                      <Badge tone="neutral">Provisional</Badge>
                    )}
                  </td>
                  <td className="px-1 py-2 text-right">
                    <Badge
                      tone={
                        p.result === "WIN"
                          ? "good"
                          : p.result === "LOSS"
                            ? "bad"
                            : p.result === "TIE"
                              ? "warn"
                              : "neutral"
                      }
                    >
                      {p.result}
                    </Badge>
                  </td>
                  <td className="px-1 py-2 text-right">
                    {confirmWeek === p.week ? (
                      <span className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy != null}
                          onClick={() => {
                            setConfirmWeek(null);
                            onDelete(p.week);
                          }}
                        >
                          {busy === `delete:${p.week}` ? <Spinner /> : null} Remove
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmWeek(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setConfirmWeek(p.week)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {confirmWeek != null ? (
          <p className="rounded-lg border border-bad/40 bg-bad/5 p-2.5 text-[11px] leading-relaxed text-bad">
            Removing a confirmed historical pick changes what the optimiser believes you have
            already spent. Only do this to correct a mistake — the team will become selectable
            again everywhere in the app.
          </p>
        ) : null}

        {snapshot.usedTeams.length > 0 ? (
          <div className="border-t border-ink-800 pt-3 text-[11px] text-ink-400">
            <span className="font-semibold text-ink-300">Permanently excluded: </span>
            {snapshot.usedTeams.join(", ")}
            <span className="text-ink-500">
              {" "}
              ({pct(snapshot.usedTeams.length / 32, 0)} of the league spent)
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
