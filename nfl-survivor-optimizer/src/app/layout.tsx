import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "NFL Survivor Optimizer",
  description:
    "Survivor / Last Man Standing optimizer for the 2026 NFL season: market-anchored win probabilities, an exact no-repeat path optimizer, and explanations you can argue with.",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/history", label: "Pick History" },
  { href: "/model", label: "Model" },
  { href: "/settings", label: "Settings" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ink-950 antialiased">
        <div className="border-b border-ink-800 bg-ink-900/60 backdrop-blur">
          <nav className="mx-auto flex max-w-[1600px] items-center gap-6 px-4 py-2.5">
            <Link href="/" className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded bg-accent/15 text-[11px] font-bold text-accent">
                SO
              </span>
              <span className="text-sm font-semibold tracking-tight text-ink-100">
                NFL Survivor Optimizer
              </span>
            </Link>
            <div className="flex items-center gap-1">
              {NAV.map((n) => (
                <Link
                  key={n.href}
                  href={n.href}
                  className="rounded px-2.5 py-1 text-xs font-medium text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
                >
                  {n.label}
                </Link>
              ))}
            </div>
          </nav>
        </div>
        <main className="mx-auto max-w-[1600px] px-4 py-5">{children}</main>
        <footer className="mx-auto max-w-[1600px] px-4 pb-10 pt-2 text-[11px] leading-relaxed text-ink-500">
          Runs entirely on your machine. Estimates are probabilities, not predictions — future
          weeks are plans that are recomputed as results and lines arrive.
        </footer>
      </body>
    </html>
  );
}
