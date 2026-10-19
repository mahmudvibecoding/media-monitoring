"use client";

import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";

import { runsOptions } from "@/api/@tanstack/react-query.gen";
import type { RunWithSteps } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { Pages } from "@/components/pages";
import { RunRow, useRunTexts } from "@/components/runs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { anyRunning, runsAddress, runsQuery, STEPS } from "@/lib/activity";
import { go } from "@/lib/address";
import { formatCount } from "@/lib/format";
import { DIMMED } from "@/lib/pages";
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

  // The pages either side, asked for once this one is shown, and a step's runs once the pointer or the keys come to it
  // in the list of steps, so that turning to them shows them at once
  const queryClient = useQueryClient();
  const shown = !!data && !isPlaceholderData;
  useEffect(() => {
    if (!shown) return;
    for (const to of [page + 1, page - 1].filter((to) => to >= 1 && to <= pages)) {
      void queryClient.prefetchQuery(runsOptions({ query: { step: query.step, page: to > 1 ? to : undefined } }));
    }
  }, [shown, page, pages, query.step, queryClient]);
  const ahead = (value: string) =>
    void queryClient.prefetchQuery(runsOptions({ query: { step: STEPS.find((name) => name === value) } }));

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
        <div className={cn("space-y-3 transition-opacity", isPlaceholderData && DIMMED)}>
          {data.runs.map((run) =>
            run.step === "round" ? (
              <Round key={run.id} run={run} />
            ) : (
              <section key={run.id} className="overflow-hidden rounded-lg border">
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
              <SelectItem
                key={option.value}
                value={option.value}
                onPointerEnter={() => ahead(option.value)}
                onFocus={() => ahead(option.value)}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {data && (
          <p className="ml-auto text-muted-foreground tabular-nums">
            {t("count", { count: data.total, formatted: formatCount(data.total, locale) })}
          </p>
        )}
      </div>
      {list}
    </div>
  );
}

// A round: its own row (when it started, how it ended, how long it took), then its steps in the order they ran, set in
// under it
function Round({ run }: { run: RunWithSteps }) {
  const t = useTranslations("activity");
  return (
    <section className="overflow-hidden rounded-lg border">
      <RunRow run={run} note={run.summary ?? undefined} className="bg-muted/40" />
      {run.steps?.length ? (
        <ul className="divide-y border-t">
          {run.steps.map((step) => (
            <li key={step.id}>
              <RunRow run={step} className="pl-8" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t px-4 py-3 pl-8 text-muted-foreground">{t("noSteps")}</p>
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
        <div key={block} className="space-y-3 rounded-lg border p-4">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-4 w-full max-w-lg" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
      ))}
    </div>
  );
}
