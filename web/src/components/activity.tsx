"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";

import { runsOptions } from "@/api/@tanstack/react-query.gen";
import type { RunWithSteps } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { Pages } from "@/components/pages";
import { OutcomeBadge, RunRow, useRunTexts } from "@/components/runs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { anyRunning, runsAddress, runsQuery, secondsOf, STEPS } from "@/lib/activity";
import { go } from "@/lib/address";
import { formatCount, formatDateTime, formatSeconds } from "@/lib/format";
import { cn } from "@/lib/utils";

export const LIVE_EVERY = 5_000; // milliseconds between looks at runs that may change

// Every run, newest first, as the address asks for (?step=youtube+comments&page=2): each round with its steps, and the
// runs started by hand; or one step's runs alone. The first page, and any page while something on it runs, is asked
// for again every few seconds, so new runs and their numbers show up.
export function Activity() {
  const t = useTranslations("activity");
  const locale = useLocale();
  const { step } = useRunTexts();
  const query = runsQuery(useSearchParams());
  const page = query.page ?? 1;
  const { data, error, isFetching, isPlaceholderData, refetch } = useQuery({
    ...runsOptions({ query }),
    placeholderData: keepPreviousData,
    refetchInterval: (current) =>
      page === 1 || (current.state.data && anyRunning(current.state.data.runs)) ? LIVE_EVERY : false,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  // Past the last page (an old link): the last page instead
  const pastTheEnd = !!data && !isPlaceholderData && data.total > 0 && data.runs.length === 0 && page > 1;
  useEffect(() => {
    if (pastTheEnd) go(runsAddress({ step: query.step, page: pages > 1 ? pages : undefined }), "replace");
  }, [pastTheEnd, query.step, pages]);

  function turn(to: number) {
    go(runsAddress({ step: query.step, page: to > 1 ? to : undefined }), "push");
    window.scrollTo({ top: 0 });
  }

  let list;
  if (!data) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <ActivitySkeleton />;
  } else if (data.total === 0) {
    list = <p className="text-muted-foreground">{t("none")}</p>;
  } else {
    list = (
      <>
        <div className={cn("space-y-4 transition-opacity", isPlaceholderData && "opacity-60")}>
          {data.runs.map((run) =>
            run.step === "round" ? (
              <Round key={run.id} run={run} />
            ) : (
              <section key={run.id} className="rounded-xl border">
                <RunRow run={run} note={run.round_id === null ? t("byHand") : undefined} />
              </section>
            ),
          )}
        </div>
        {pages > 1 && <Pages page={page} pages={pages} turn={turn} />}
      </>
    );
  }

  const options = [
    { value: "", label: t("allSteps") },
    ...STEPS.map((name) => ({ value: name, label: step(name).name })),
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          items={options}
          value={query.step ?? ""}
          onValueChange={(value) => go(runsAddress({ step: STEPS.find((name) => name === value) }), "push")}
        >
          <SelectTrigger aria-label={t("step")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data && (
          <p className="ml-auto text-sm text-muted-foreground tabular-nums">
            {t("count", { count: data.total, formatted: formatCount(data.total, locale) })}
          </p>
        )}
      </div>
      {list}
    </div>
  );
}

// A round: when it started, how it ended and how long it took, then its steps in the order they ran
function Round({ run }: { run: RunWithSteps }) {
  const t = useTranslations("activity");
  const locale = useLocale();
  const { name } = useRunTexts();
  return (
    <section className="rounded-xl border">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
        <Link href={`/activity/${run.id}`} className="font-semibold hover:underline">
          {name(run)}
        </Link>
        <OutcomeBadge outcome={run.outcome} />
        <span className="text-sm text-muted-foreground tabular-nums">
          {formatDateTime(run.started_at, locale)} · {formatSeconds(secondsOf(run), locale)}
        </span>
        {run.summary && <span className="text-sm text-muted-foreground">{run.summary}</span>}
      </header>
      {run.steps?.length ? (
        <ul className="divide-y">
          {run.steps.map((step) => (
            <li key={step.id}>
              <RunRow run={step} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t("noSteps")}</p>
      )}
    </section>
  );
}

// The page's shape while the first runs load
function ActivitySkeleton() {
  const t = useTranslations("common");
  return (
    <div className="space-y-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: 3 }, (_, block) => (
        <div key={block} className="space-y-3 rounded-xl border p-4">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-4 w-full max-w-lg" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
      ))}
    </div>
  );
}
