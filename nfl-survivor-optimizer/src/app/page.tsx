import { buildAnalysis } from "@/lib/engine";
import type { AnalysisSnapshot } from "@/lib/engine";
import { Dashboard } from "@/components/Dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

// The dashboard reads live pool state and provider snapshots, so it must never
// be statically cached.
export const dynamic = "force-dynamic";

export default async function Home() {
  // Only the data fetch is guarded. Constructing JSX inside the try block would
  // be misleading: React renders lazily, so a render-time error from <Dashboard>
  // would escape this catch anyway and belongs to an error boundary instead.
  let snapshot: AnalysisSnapshot | null = null;
  let error: string | null = null;
  try {
    snapshot = await buildAnalysis({ includeRobustness: false });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (snapshot) {
    return <Dashboard initial={snapshot} />;
  }

  return (
    <Card className="mx-auto mt-10 max-w-2xl border-bad/40">
      <CardHeader>
        <CardTitle className="text-bad">Nothing to analyse yet</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-ink-300">
        <p>{error}</p>
        <pre className="rounded-lg border border-ink-700 bg-ink-950 p-3 text-xs text-ink-200">
          npm run db:setup{"\n"}npm run db:seed
        </pre>
        <p className="text-xs text-ink-400">
          Seeding pulls the season schedule from nflverse. No API key is required for that step.
        </p>
      </CardContent>
    </Card>
  );
}
