"use client";

import Link from "next/link";
import { useLocale, useMessages, useTranslations } from "next-intl";

import type { Run } from "@/api/types.gen";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { numberOf, secondsOf } from "@/lib/activity";
import { formatCount, formatDateTime, formatSeconds } from "@/lib/format";

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

const BADGES = {
  running: "default",
  finished: "secondary",
  stopped: "outline",
  failed: "destructive",
  lost: "destructive",
} as const;

// How a run ended, or that it's still going
export function OutcomeBadge({ outcome }: { outcome: Run["outcome"] }) {
  const t = useTranslations("activity.outcomes");
  return (
    <Badge variant={BADGES[outcome]} title={outcome === "lost" ? t("lostHint") : undefined}>
      {t(outcome)}
    </Badge>
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
  return <p className="text-sm text-muted-foreground tabular-nums">{parts.join(" · ")}</p>;
}

// A run in a list: its name (a link to its page), how it ended, when it started and how long it took, its main
// numbers, and how far it is while it runs
export function RunRow({ run, note }: { run: Run; note?: string }) {
  const locale = useLocale();
  const { name } = useRunTexts();
  const items = numberOf(run.numbers, "items");
  const done = numberOf(run.numbers, "done") ?? 0;
  return (
    <div className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link href={`/activity/${run.id}`} className="font-medium hover:underline">
          {name(run)}
        </Link>
        <OutcomeBadge outcome={run.outcome} />
        <span className="text-sm text-muted-foreground tabular-nums">
          {formatDateTime(run.started_at, locale)} · {formatSeconds(secondsOf(run), locale)}
        </span>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <RunLine run={run} />
      {run.outcome === "running" && items ? <Progress value={(done / items) * 100} className="max-w-md" /> : null}
    </div>
  );
}
