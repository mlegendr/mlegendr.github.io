"use client";

import * as React from "react";
import type { ImportPreview } from "@/lib/gametheory/types";
import { cn } from "@/lib/ui";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Spinner, Switch } from "../ui";

const SAMPLE_LONG = `entry,week,team
Me,1,PHI
Entry A,1,BAL
Entry B,1,CIN
Entry C,1,BUF
Me,2,DAL
Entry A,2,KC
Entry B,2,DET
Entry C,2,SF`;

const SAMPLE_WIDE = `entry,week1,week2,week3,week4
Me,PHI,DAL,BUF,
Entry A,BAL,KC,,
Entry B,CIN,DET,,
Entry C,BUF,SF,,`;

const SAMPLE_OWNER = `entry,owner,week,team
Alice Entry 1,Alice,1,BAL
Alice Entry 2,Alice,1,BUF
Bob Entry 1,Bob,1,CIN`;

/** §3 — import with a mandatory preview; nothing is written until you commit. */
export function EntryImportPanel({ onImported }: { onImported: () => void }) {
  const [csv, setCsv] = React.useState("");
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [replace, setReplace] = React.useState(false);
  const [userEntryName, setUserEntryName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  const call = async (commit: boolean) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/entries/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          csv,
          commit,
          replaceExisting: replace,
          userEntryName: userEntryName.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Import failed");
      setPreview(json.preview);
      if (json.error) setError(json.error);
      if (json.committed) {
        setResult(
          `Imported ${json.writtenPicks} pick(s) across ${json.preview.totals.entries} entries (${json.createdEntries} new). ${json.eliminated} entry/entries are now eliminated.`,
        );
        onImported();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    const text = await file.text();
    setCsv(text);
    setPreview(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import pool-entry history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[11px] leading-relaxed text-ink-500">
          Paste or upload every entry&apos;s prior selections. Team names are normalised
          automatically (<code className="text-ink-400">KC</code>,{" "}
          <code className="text-ink-400">Kansas City Chiefs</code>,{" "}
          <code className="text-ink-400">OAK</code> all resolve). Nothing is written until you press
          Commit, and invalid rows are always reported rather than dropped.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setCsv(SAMPLE_LONG)}>
            Long sample
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCsv(SAMPLE_WIDE)}>
            Wide sample
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCsv(SAMPLE_OWNER)}>
            Owner sample
          </Button>
          <label className="cursor-pointer rounded-lg px-3 py-1 text-xs font-medium text-ink-300 hover:bg-ink-800 hover:text-ink-100">
            Upload CSV
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </label>
        </div>

        <textarea
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setPreview(null);
          }}
          rows={8}
          spellCheck={false}
          placeholder={"entry,week,team\nMe,1,PHI\nEntry A,1,BAL"}
          className="w-full rounded-lg border border-ink-600 bg-ink-950 p-3 font-mono text-[11px] text-ink-100 placeholder:text-ink-600 focus:border-accent/60 focus:outline-none"
        />

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-ink-400">
              Which CSV entry is yours?
            </span>
            <Input
              value={userEntryName}
              onChange={(e) => setUserEntryName(e.target.value)}
              placeholder='e.g. "Me" (optional)'
              className="h-8 w-48 text-xs"
            />
          </div>
          <Button size="sm" variant="outline" disabled={busy || !csv.trim()} onClick={() => call(false)}>
            {busy ? <Spinner /> : null} Preview
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !preview?.committable}
            onClick={() => call(true)}
          >
            Commit import
          </Button>
          <span className="flex items-center gap-2 text-xs text-ink-400">
            <Switch checked={replace} onCheckedChange={setReplace} />
            Replace existing opponent picks
          </span>
        </div>
        <p className="text-[10px] leading-relaxed text-ink-600">
          Naming your own row merges it into your existing entry instead of creating a rival. Your
          own picks stay owned by the Confirm button on the dashboard — the survival optimizer reads
          those, and importing never overwrites them.
        </p>

        {error ? (
          <p className="rounded-lg border border-bad/40 bg-bad/5 p-2.5 text-xs text-bad">{error}</p>
        ) : null}
        {result ? (
          <p className="rounded-lg border border-good/40 bg-good/5 p-2.5 text-xs text-good">{result}</p>
        ) : null}

        {preview ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <Badge tone="accent">{preview.format} format</Badge>
              <span className="text-ink-300">{preview.totals.rows} picks</span>
              <span className="text-ink-300">{preview.totals.entries} entries</span>
              {preview.totals.errors > 0 ? (
                <Badge tone="bad">{preview.totals.errors} errors</Badge>
              ) : (
                <Badge tone="good">no errors</Badge>
              )}
              {preview.totals.warnings > 0 ? (
                <Badge tone="warn">{preview.totals.warnings} warnings</Badge>
              ) : null}
            </div>

            {preview.issues.length > 0 ? (
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-ink-700 bg-ink-850/50 p-3 text-[11px]">
                {preview.issues.map((issue, i) => (
                  <li
                    key={i}
                    className={cn(
                      "flex gap-2",
                      issue.severity === "ERROR" ? "text-bad" : "text-warn",
                    )}
                  >
                    <span className="shrink-0 font-semibold">{issue.kind}</span>
                    <span className="text-ink-300">{issue.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {preview.entries.length > 0 ? (
              <div className="scroll-x">
                <table className="w-full min-w-[420px] text-xs">
                  <thead>
                    <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                      <th className="py-1 text-left">Entry</th>
                      <th className="py-1 text-left">Owner</th>
                      <th className="py-1 text-left">Picks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.entries.map((e) => (
                      <tr key={e.name} className="border-b border-ink-850/70">
                        <td className="py-1.5 font-semibold text-ink-100">{e.name}</td>
                        <td className="py-1.5 text-ink-400">{e.owner ?? "—"}</td>
                        <td className="py-1.5 text-ink-300">
                          {e.weeks.map((w, i) => `W${w} ${e.teams[i]}`).join("  ·  ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Small form for adding a single opponent entry by hand. */
export function AddEntryPanel({ onAdded }: { onAdded: () => void }) {
  const [name, setName] = React.useState("");
  const [owner, setOwner] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/entries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: name, ownerName: owner || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not add entry");
      setName("");
      setOwner("");
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add an entry manually</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Entry name" />
          <Input
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="Owner (optional)"
          />
        </div>
        <Button size="sm" variant="outline" disabled={busy || !name.trim()} onClick={submit}>
          {busy ? <Spinner /> : null} Add entry
        </Button>
        {error ? <p className="text-xs text-bad">{error}</p> : null}
        <p className="text-[10px] text-ink-600">
          One human with several entries should be added as several entries sharing an owner name —
          they stay completely independent.
        </p>
      </CardContent>
    </Card>
  );
}
