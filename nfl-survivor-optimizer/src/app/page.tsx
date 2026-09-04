import { buildAnalysis } from "@/lib/engine";
import { Dashboard } from "@/components/Dashboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

// The dashboard reads live pool state and provider snapshots, so it must never
// be statically cached.
export const dynamic = "force-dynamic";

export default async function Home() {
  try {
    const snapshot = await buildAnalysis({ includeRobustness: false });
    return <Dashboard initial={snapshot} />;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return (
      <Card className="mx-auto mt-10 max-w-2xl border-bad/40">
        <CardHeader>
          <CardTitle className="text-bad">Nothing to analyse yet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-ink-300">
          <p>{message}</p>
          <pre className="rounded-lg border border-ink-700 bg-ink-950 p-3 text-xs text-ink-200">
            npm run db:setup{"\n"}npm run db:seed
          </pre>
          <p className="text-xs text-ink-400">
            Seeding pulls the {new Date().getFullYear()} schedule from nflverse. No API key is
            required for that step.
          </p>
        </CardContent>
      </Card>
    );
  }
}
