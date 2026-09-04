"use client";

/**
 * Small shadcn/ui-style primitives.
 *
 * Written by hand rather than pulled in through the shadcn CLI so the app has no
 * network dependency at install time and no Radix runtime; the API and Tailwind
 * conventions follow shadcn closely so components can be swapped for the real
 * ones later.
 */

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/ui";

/* -------------------------------------------------------------- Card ----- */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-ink-700 bg-ink-900/80 shadow-lg shadow-black/20",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pt-4 pb-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn(
        "text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300",
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5", className)} {...props} />;
}

/* ------------------------------------------------------------ Button ----- */

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
  {
    variants: {
      variant: {
        primary: "bg-accent text-ink-950 hover:bg-accent/85",
        secondary: "bg-ink-700 text-ink-100 hover:bg-ink-600",
        outline: "border border-ink-600 text-ink-200 hover:bg-ink-800",
        ghost: "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
        danger: "bg-bad/15 text-bad border border-bad/40 hover:bg-bad/25",
        success: "bg-good/15 text-good border border-good/40 hover:bg-good/25",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4",
        lg: "h-11 px-6 text-base",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

/* ------------------------------------------------------------- Badge ----- */

export function Badge({
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "good" | "warn" | "bad" | "accent" | "violet";
}) {
  const tones: Record<string, string> = {
    neutral: "border-ink-600 bg-ink-800 text-ink-300",
    good: "border-good/40 bg-good/10 text-good",
    warn: "border-warn/40 bg-warn/10 text-warn",
    bad: "border-bad/40 bg-bad/10 text-bad",
    accent: "border-accent/40 bg-accent/10 text-accent",
    violet: "border-violet/40 bg-violet/10 text-violet",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

/* ------------------------------------------------------------- Input ----- */

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-lg border border-ink-600 bg-ink-850 px-3 text-sm text-ink-100 placeholder:text-ink-500",
        "focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 rounded-lg border border-ink-600 bg-ink-850 px-2 text-sm text-ink-100",
        "focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("block text-xs font-medium uppercase tracking-wide text-ink-400", className)}
      {...props}
    />
  );
}

export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50",
        checked ? "border-accent/60 bg-accent/70" : "border-ink-600 bg-ink-700",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-ink-100 transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/* -------------------------------------------------------------- Tabs ----- */

export function Tabs({
  value,
  onValueChange,
  options,
  className,
  size = "md",
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      className={cn("inline-flex rounded-lg border border-ink-700 bg-ink-850 p-0.5", className)}
      role="tablist"
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onValueChange(o.value)}
          className={cn(
            "rounded-md font-medium transition-colors",
            size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3 py-1.5 text-xs",
            value === o.value
              ? "bg-accent/15 text-accent"
              : "text-ink-400 hover:text-ink-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ Tooltip ---- */

/** CSS-only hover card. Enough for the heatmap and column explainers. */
export function Hint({
  children,
  content,
  className,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("group/hint relative inline-flex", className)}>
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-[11px] font-normal normal-case tracking-normal text-ink-200 shadow-xl group-hover/hint:block">
        {content}
      </span>
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "good" | "warn" | "bad" | "accent";
  className?: string;
}) {
  const toneClass =
    tone === "good"
      ? "text-good"
      : tone === "warn"
        ? "text-warn"
        : tone === "bad"
          ? "text-bad"
          : tone === "accent"
            ? "text-accent"
            : "text-ink-100";
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">
        {label}
      </div>
      <div className={cn("tabular text-lg font-semibold leading-tight", toneClass)}>{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-ink-400">{sub}</div> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-500 border-t-accent",
        className,
      )}
    />
  );
}
