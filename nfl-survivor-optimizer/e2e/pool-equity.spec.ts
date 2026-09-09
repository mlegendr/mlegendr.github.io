/**
 * End-to-end coverage of the multi-entry pool game theory.
 *
 * Runs against the dedicated e2e database, so importing a synthetic field here
 * can never touch a real pool.
 */
import { expect, test, type Page } from "@playwright/test";

const CSV = `entry,owner,week,team
Me,Mark,1,PHI
Alice Entry 1,Alice,1,BAL
Alice Entry 2,Alice,1,BUF
Bob Entry 1,Bob,1,CIN
Carol Entry 1,Carol,1,DAL`;

async function resetField(page: Page) {
  const res = await page.request.get("/api/entries");
  const json = await res.json();
  for (const s of json.entries ?? []) {
    if (!s.entry.isUser) await page.request.delete(`/api/entries?id=${s.entry.id}`);
  }
}

test.beforeEach(async ({ page }) => {
  await resetField(page);
});

test("pool state page renders and reports an empty field honestly", async ({ page }) => {
  await page.goto("/pool");
  await expect(page.getByRole("heading", { name: /Pool state — 2026/i })).toBeVisible();
  await expect(page.getByText("Original entries")).toBeVisible();
  await expect(page.getByText("Entries remaining")).toBeVisible();
  await expect(page.getByText(/Field inventory/i)).toBeVisible();
});

test("CSV import previews before committing and never silently discards", async ({ page }) => {
  // A file with a real error must not be committable.
  const bad = await page.request.post("/api/entries/import", {
    data: { csv: "entry,week,team\nE1,1,BUF\nE1,3,BUF", commit: true },
  });
  const badJson = await bad.json();
  expect(badJson.committed).toBe(false);
  expect(badJson.preview.issues.some((i: { kind: string }) => i.kind === "TEAM_REUSED_BY_ENTRY")).toBe(true);

  // A clean file previews, then commits.
  const preview = await (
    await page.request.post("/api/entries/import", { data: { csv: CSV, commit: false } })
  ).json();
  expect(preview.committed).toBe(false);
  expect(preview.preview.committable).toBe(true);
  expect(preview.preview.totals.entries).toBe(5);

  const commit = await (
    await page.request.post("/api/entries/import", {
      data: { csv: CSV, commit: true, replaceExisting: true, userEntryName: "Me" },
    })
  ).json();
  expect(commit.committed).toBe(true);
  // "Me" merged into the user's own entry rather than creating a rival.
  expect(commit.createdEntries).toBe(4);
});

test("entries keep independent inventories, including same-owner entries", async ({ page }) => {
  await page.request.post("/api/entries/import", {
    data: { csv: CSV, commit: true, replaceExisting: true, userEntryName: "Me" },
  });
  const json = await (await page.request.get("/api/entries")).json();
  const a1 = json.entries.find((s: { entry: { displayName: string } }) => s.entry.displayName === "Alice Entry 1");
  const a2 = json.entries.find((s: { entry: { displayName: string } }) => s.entry.displayName === "Alice Entry 2");
  expect(a1.entry.ownerName).toBe("Alice");
  expect(a2.entry.ownerName).toBe("Alice");
  // Same owner, completely separate inventories.
  const shared = a1.usedTeams.filter((t: string) => a2.usedTeams.includes(t));
  expect(shared).toHaveLength(0);
  for (const s of json.entries) {
    expect(s.remainingTeams).toHaveLength(32 - s.usedTeams.length);
  }
});

test("the pool state page lists imported entries and their inventories", async ({ page }) => {
  await page.request.post("/api/entries/import", {
    data: { csv: CSV, commit: true, replaceExisting: true, userEntryName: "Me" },
  });
  await page.goto("/pool");
  await expect(page.getByText("Alice Entry 1").first()).toBeVisible();
  await expect(page.getByText("Alice Entry 2").first()).toBeVisible();
  await expect(page.getByText("Bob Entry 1").first()).toBeVisible();
});

test("the tournament produces pool win probability and prize equity for candidates", async ({ page }) => {
  await page.request.post("/api/entries/import", {
    data: { csv: CSV, commit: true, replaceExisting: true, userEntryName: "Me" },
  });
  const res = await page.request.post("/api/pool-equity", {
    data: { simulations: 2000, sensitivity: false },
    timeout: 180_000,
  });
  const json = await res.json();
  expect(res.ok()).toBe(true);

  const candidates = json.analysis.tournament.candidates;
  expect(candidates.length).toBeGreaterThan(5);
  for (const c of candidates) {
    expect(c.poolWinProbability).toBeGreaterThanOrEqual(0);
    expect(c.poolWinProbability).toBeLessThanOrEqual(1);
    expect(c.expectedPrizeEquity).toBeGreaterThanOrEqual(0);
    // Equity can never exceed the probability of winning at all.
    expect(c.expectedPrizeEquity).toBeLessThanOrEqual(c.poolWinProbability + 1e-9);
    expect(c.soleVictoryProbability).toBeLessThanOrEqual(c.poolWinProbability + 1e-9);
  }

  // Every opposing entry's distribution normalises to one.
  for (const d of json.analysis.currentDistributions) {
    const total = Object.values(d.distribution as Record<string, number>).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBeCloseTo(1, 6);
  }

  // Both recommendations exist and are reported separately.
  expect(json.survival.team).toBeTruthy();
  expect(json.analysis.tournament.bestTeam).toBeTruthy();
  expect(json.objective).toBe("EXPECTED_PRIZE_EQUITY");
});

test("results are reproducible for a fixed seed", async ({ page }) => {
  await page.request.post("/api/entries/import", {
    data: { csv: CSV, commit: true, replaceExisting: true, userEntryName: "Me" },
  });
  const run = async () =>
    (
      await (
        await page.request.post("/api/pool-equity", {
          data: { simulations: 1000, sensitivity: false, seed: 4242 },
          timeout: 180_000,
        })
      ).json()
    ).analysis.tournament.candidates.map((c: { team: string; expectedPrizeEquity: number }) => [
      c.team,
      c.expectedPrizeEquity,
    ]);
  expect(await run()).toEqual(await run());
});

test("a known current pick overrides the predicted distribution", async ({ page }) => {
  await page.request.post("/api/entries/import", {
    data: { csv: CSV, commit: true, replaceExisting: true, userEntryName: "Me" },
  });
  const entries = await (await page.request.get("/api/entries")).json();
  const target = entries.entries.find((s: { entry: { isUser: boolean } }) => !s.entry.isUser);
  const week = entries.week;

  await page.request.post("/api/entries/picks", {
    data: { entryId: target.entry.id, week, team: "SEA", isKnown: true },
  });

  const json = await (
    await page.request.post("/api/pool-equity", {
      data: { simulations: 800, sensitivity: false },
      timeout: 180_000,
    })
  ).json();
  const dist = json.analysis.currentDistributions.find(
    (d: { entryId: string }) => d.entryId === target.entry.id,
  );
  expect(dist.isKnown).toBe(true);
  expect(dist.distribution).toEqual({ SEA: 1 });
});

test("the dashboard shows both recommendations side by side", async ({ page }) => {
  await page.request.post("/api/entries/import", {
    data: { csv: CSV, commit: true, replaceExisting: true, userEntryName: "Me" },
  });
  await page.goto("/");
  await expect(page.getByText("Survival pick")).toBeVisible();
  await expect(page.getByText("Pool-equity pick")).toBeVisible();
  await expect(page.getByText(/Pool-equity optimizer/i)).toBeVisible();
  // No vague aggregate score is ever presented as the output.
  await expect(page.getByText(/Game Theory Score/i)).toHaveCount(0);
});

test("snapshots are written once and drive the retrospective", async ({ page }) => {
  await page.request.post("/api/entries/import", {
    data: { csv: CSV, commit: true, replaceExisting: true, userEntryName: "Me" },
  });
  const first = await (
    await page.request.post("/api/pool-equity/snapshot", {
      data: { simulations: 800 },
      timeout: 180_000,
    })
  ).json();
  expect(first.created).toBe(true);

  // A second call must preserve the pre-lock prediction, not overwrite it.
  const second = await (
    await page.request.post("/api/pool-equity/snapshot", {
      data: { simulations: 800 },
      timeout: 180_000,
    })
  ).json();
  expect(second.created).toBe(false);

  await page.goto("/retrospective");
  await expect(page.getByRole("heading", { name: /Retrospective/i })).toBeVisible();
});

test("the survival optimizer is unaffected by the presence of a field", async ({ page }) => {
  const before = await (await page.request.get("/api/analysis")).json();
  await page.request.post("/api/entries/import", {
    data: { csv: CSV, commit: true, replaceExisting: true, userEntryName: "Me" },
  });
  const after = await (await page.request.get("/api/analysis")).json();

  // Same recommendation, same numbers — game theory is strictly additive.
  expect(after.candidates[0].team).toBe(before.candidates[0].team);
  expect(after.candidates[0].currentWinProb).toBeCloseTo(before.candidates[0].currentWinProb, 10);
  expect(after.usedTeams).toEqual(before.usedTeams);
  expect(after.seasonPath.map((s: { team: string }) => s.team)).toEqual(
    before.seasonPath.map((s: { team: string }) => s.team),
  );
});
