/**
 * End-to-end smoke tests.
 *
 * The webServer defined in playwright.config.ts seeds a database and starts the
 * app with OFFLINE_MODE=1, so these tests never touch a third-party API.
 */
import { expect, test, type Page } from "@playwright/test";

/** Remove any pick left behind by an earlier run so tests are order-independent. */
async function resetPicks(page: Page) {
  const res = await page.request.get("/api/pool/export");
  const dump = await res.json();
  for (const p of dump.picks ?? []) {
    await page.request.delete(`/api/picks?week=${p.week}`);
  }
}

test.beforeEach(async ({ page }) => {
  await resetPicks(page);
});

test("dashboard renders the weekly recommendation with all three probabilities", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "NFL Survivor Optimizer" })).toBeVisible();
  await expect(page.getByText(/Week \d+ recommendation/i)).toBeVisible();

  // The card must expose market, model and final probabilities separately.
  await expect(page.getByText("Current win probability")).toBeVisible();
  await expect(page.getByText("Market probability")).toBeVisible();
  await expect(page.getByText("Model probability")).toBeVisible();
  await expect(page.getByText(/path survival/i).first()).toBeVisible();

  // ...and the explanation, not just a score.
  await expect(page.getByText(/^Why /).first()).toBeVisible();
});

test("teams remaining starts at 32 and the rankings table lists every team", async ({ page }) => {
  await page.goto("/");
  const header = page.locator("header");
  await expect(header).toContainText("Teams remaining");
  await expect(header).toContainText("32");
  await expect(page.getByText(/rankings — all 32 teams/i)).toBeVisible();

  const analysis = await (await page.request.get("/api/analysis")).json();
  expect(analysis.teamsRemaining).toBe(32);
  expect(analysis.slots.filter((s: { week: number }) => s.week === analysis.recommendationWeek))
    .toHaveLength(32);
});

test("confirming a pick permanently excludes the team", async ({ page }) => {
  await page.goto("/");

  const heading = page.locator("h1", { hasText: "NFL Survivor Optimizer" });
  await expect(heading).toBeVisible();

  const confirmButton = page.getByRole("button", { name: /^Confirm .* as week \d+ pick$/ });
  await expect(confirmButton).toBeVisible();
  const label = (await confirmButton.textContent()) ?? "";
  const team = label.match(/Confirm (\w+) as week/)?.[1];
  expect(team).toBeTruthy();

  await confirmButton.click();
  await page.getByRole("button", { name: "Yes, confirm" }).click();

  // Teams remaining drops, the team appears in the used list, and it is gone
  // from the candidate table.
  const header = page.locator("header");
  await expect(header).toContainText("Teams used", { timeout: 20_000 });
  await expect(header).toContainText("31", { timeout: 20_000 });

  const analysis = await (await page.request.get("/api/analysis")).json();
  expect(analysis.usedTeams).toContain(team);
  expect(analysis.teamsRemaining).toBe(31);
  expect(analysis.candidates.some((c: { team: string }) => c.team === team)).toBe(false);
  expect(analysis.seasonPath.some((s: { team: string }) => s.team === team)).toBe(false);
});

test("a confirmed pick survives a page reload (server-side persistence)", async ({ page }) => {
  await page.request.post("/api/picks", {
    data: { week: 1, team: "KC", confirmed: true },
  });

  await page.goto("/history");
  await expect(page.getByText("Kansas City Chiefs")).toBeVisible();

  await page.reload();
  await expect(page.getByText("Kansas City Chiefs")).toBeVisible();
  await expect(page.getByText("Confirmed").first()).toBeVisible();
});

test("the season heatmap and path planner render", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/Season heatmap/i)).toBeVisible();
  await expect(page.getByText(/Optimal survival path/i)).toBeVisible();
  await expect(page.getByText(/plans, not picks/i)).toBeVisible();
});

test("horizon comparison shows a result for every horizon", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Optimization horizons")).toBeVisible();
  for (const label of ["3-week best", "6-week best", "9-week best", "Rest of season best"]) {
    await expect(page.getByText(label)).toBeVisible();
  }
});

test("data status panel is visible and honest about degraded providers", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Data status")).toBeVisible();
  // The e2e server runs with OFFLINE_MODE=1, so it must say so rather than
  // pretending everything is fresh.
  // No ODDS_API_KEY is configured for the e2e run, so the odds provider must be
  // reported as degraded rather than presented as a live multi-book market.
  await expect(page.getByText(/Degraded/i).first()).toBeVisible();
});

test("settings page saves a pool rule", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("A tie counts as a loss")).toBeVisible();

  const toggle = page
    .locator("div", { hasText: /^A tie counts as a loss/ })
    .getByRole("switch")
    .first();
  await toggle.click();

  await expect(page.getByText(/Saved at/)).toBeVisible({ timeout: 15_000 });
  const settings = await (await page.request.get("/api/settings")).json();
  expect(settings.settings.tieCountsAsLoss).toBe(false);

  // Put it back.
  await page.request.patch("/api/settings", { data: { tieCountsAsLoss: true } });
});

test("API key VALUES never reach the browser", async ({ page }) => {
  // playwright.config.ts starts the server with these sentinel keys.
  const sentinels = ["e2e-sentinel-odds-key", "e2e-sentinel-sportsdataio-key"];

  for (const path of ["/", "/settings", "/model", "/history"]) {
    await page.goto(path);
    const html = await page.content();
    for (const secret of sentinels) expect(html).not.toContain(secret);
  }

  const settings = await (await page.request.get("/api/settings")).json();
  // The settings endpoint reports availability as booleans only.
  for (const v of Object.values(settings.providers)) expect(typeof v).toBe("boolean");
  const body = JSON.stringify(settings);
  for (const secret of sentinels) expect(body).not.toContain(secret);

  const analysis = JSON.stringify(await (await page.request.get("/api/analysis")).json());
  for (const secret of sentinels) expect(analysis).not.toContain(secret);
});

test("model page reports training provenance", async ({ page }) => {
  await page.goto("/model");
  await expect(page.getByRole("heading", { name: "Team model" })).toBeVisible();
  await expect(page.getByText("Training seasons")).toBeVisible();
  await expect(page.getByText(/Calibration/i).first()).toBeVisible();
});
