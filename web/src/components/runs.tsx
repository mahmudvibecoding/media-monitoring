"use client";

import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleMinusIcon,
  CircleXIcon,
  LoaderCircleIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useMessages, useTranslations } from "next-intl";

import type { Run } from "@/api/types.gen";
import { Progress } from "@/components/ui/progress";
import { When } from "@/components/when";
import { numberOf, secondsOf } from "@/lib/activity";
import { formatCount, formatSeconds } from "@/lib/format";
import { cn } from "@/lib/utils";

type StepTexts = { name: string; items?: string; saved?: string; results?: Record<string, string> };

// What the activity's pages say about runs: each step's texts are looked up by its own name (messages/*.json,
// activity.steps), as the runs table has it, and so are the names of its counts; one without a text shows as it is.
export function useRunTexts() {
  const t = useTranslations("activity");
  const texts = useMessages().activity;
  const steps: Record<string, StepTexts> = texts.steps;
  const words: Record<string, string> = texts.arguments;
  const locale = useLocale();
  const step = (name: string): StepTexts => steps[name] ?? { name };
  // A run's name: its step's, and what its argument says ("Comments, 365 days")
  const name = (run: Run) => {
    const argument = run.argument;
    if (!argument) return step(run.step).name;
    const said = /^\d+$/.test(argument)
      ? t("days", { count: Number(argument), formatted: formatCount(Number(argument), locale) })
      : (words[argument] ?? argument);
    return `${step(run.step).name}, ${said}`;
  };
  return { step, name };
}

const OUTCOMES: Record<Run["outcome"], { icon: LucideIcon; className: string }> = {
  running: { icon: LoaderCircleIcon, className: "text-success [&>svg]:animate-spin" },
  finished: { icon: CircleCheckIcon, className: "text-muted-foreground" },
  stopped: { icon: CircleMinusIcon, className: "text-warning" },
  failed: { icon: CircleXIcon, className: "text-destructive" },
  lost: { icon: CircleAlertIcon, className: "text-destructive" },
};

// How a run ended, or that it's still going: an icon and a word, colored only when it isn't simply finished
export function Outcome({ outcome }: { outcome: Run["outcome"] }) {
  const t = useTranslations("activity.outcomes");
  const { icon: Icon, className } = OUTCOMES[outcome];
  return (
    <span
      className={cn("inline-flex items-center gap-1 text-xs font-medium", className)}
      title={outcome === "lost" ? t("lostHint") : undefined}
    >
      <Icon className="size-3.5" />
      {t(outcome)}
    </span>
  );
}

// A run's main numbers, in one line: for a step, its items (done of how many, while unfinished), what it saved, its
// failures and the proxies working at the end; for "uv run proxies", its lists, configs and proxies
export function RunLine({ run }: { run: Run }) {
  const t = useTranslations("activity.line");
  const locale = useLocale();
  const { step } = useRunTexts();
  const numbers = run.numbers;
  const parts: string[] = [];
  const add = (label: string | undefined, value: number | undefined) => {
    if (label && value !== undefined) parts.push(`${label}: ${formatCount(value, locale)}`);
  };
  if (run.step === "proxies") {
    add(t("vpnLists"), numberOf(numbers, "vpn", "lists"));
    add(t("configs"), numberOf(numbers, "vpn", "unique"));
    add(t("plainProxies"), numberOf(numbers, "plain", "unique"));
    add(t("inSingbox"), numberOf(numbers, "singbox", "local_proxies"));
  } else if (run.step !== "round") {
    const texts = step(run.step);
    const items = numberOf(numbers, "items");
    const done = numberOf(numbers, "done");
    if (items !== undefined && done !== undefined && done < items) {
      parts.push(`${texts.items}: ${formatCount(done, locale)} / ${formatCount(items, locale)}`);
    } else {
      add(texts.items, items);
    }
    add(texts.saved, numberOf(numbers, "saved"));
    add(t("failed"), numberOf(numbers, "results", "failed"));
    add(t("workingProxies"), numberOf(numbers, "working_proxies"));
  }
  if (!parts.length) return null;
  return <p className="text-muted-foreground tabular-nums">{parts.join(" · ")}</p>;
}

// A run in a list, which opens its page wherever it's clicked: its name, how it ended, when it started and how long it
// took, its main numbers, and how far it is while it runs
export function RunRow({ run, note, className }: { run: Run; note?: string; className?: string }) {
  const locale = useLocale();
  const { name } = useRunTexts();
  const items = numberOf(run.numbers, "items");
  const done = numberOf(run.numbers, "done") ?? 0;
  return (
    <div className={cn("relative space-y-1.5 px-4 py-3 transition-colors hover:bg-muted/60", className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* Its clickable area covers the whole row */}
        <Link href={`/activity/${run.id}`} className="font-medium after:absolute after:inset-0">
          {name(run)}
        </Link>
        <Outcome outcome={run.outcome} />
        <span className="text-muted-foreground tabular-nums">
          <When iso={run.started_at} /> · {formatSeconds(secondsOf(run), locale)}
        </span>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <RunLine run={run} />
      {run.outcome === "running" && items ? <Progress value={(done / items) * 100} className="max-w-md" /> : null}
    </div>
  );
}
