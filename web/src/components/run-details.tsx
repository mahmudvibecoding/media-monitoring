"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useMessages, useTranslations } from "next-intl";

import { runDetailsOptions } from "@/api/@tanstack/react-query.gen";
import type { RunWithSteps } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { LIVE_EVERY } from "@/components/activity";
import { OutcomeBadge, RunRow, useRunTexts } from "@/components/runs";
import { Stat } from "@/components/stat";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { anyRunning, countsOf, numberOf, secondsOf } from "@/lib/activity";
import { formatCount, formatDateTime, formatSeconds } from "@/lib/format";

// One run's page: its name, how it ended, when and for how long, its last line, and every number it kept; a round's
// page lists its steps. While it runs, the page asks again every few seconds.
export function RunDetails({ id }: { id: number }) {
  const t = useTranslations("activity");
  const locale = useLocale();
  const { name } = useRunTexts();
  const { data, error, isFetching, refetch } = useQuery({
    ...runDetailsOptions({ path: { run_id: id } }),
    refetchInterval: (current) => (current.state.data && anyRunning([current.state.data]) ? LIVE_EVERY : false),
  });
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <DetailsSkeleton />;
  }
  const going = anyRunning([data]);
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{name(data)}</h1>
          <OutcomeBadge outcome={data.outcome} />
        </div>
        <p className="text-sm text-muted-foreground tabular-nums">
          {t("started")}: {formatDateTime(data.started_at, locale)}
          {data.finished_at && ` · ${t("finished")}: ${formatDateTime(data.finished_at, locale)}`}
          {` · ${going ? t("goingFor") : t("took")}: ${formatSeconds(secondsOf(data), locale)}`}
        </p>
        {data.round_id !== null && (
          <p className="text-sm">
            <Link href={`/activity/${data.round_id}`} className="hover:underline">
              {t("inRound")}
            </Link>
          </p>
        )}
        {data.summary && (
          <p className="max-w-3xl rounded-lg bg-muted px-3 py-2 font-mono text-sm break-words">{data.summary}</p>
        )}
      </header>
      {data.step === "round" ? (
        <Steps run={data} />
      ) : data.step === "proxies" ? (
        <ProxiesNumbers numbers={data.numbers} />
      ) : (
        <StepNumbers run={data} />
      )}
    </div>
  );
}

// A round's steps, in the order they ran
function Steps({ run }: { run: RunWithSteps }) {
  const t = useTranslations("activity");
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t("stepsTitle")}</h2>
      {run.steps?.length ? (
        <ul className="divide-y rounded-xl border">
          {run.steps.map((step) => (
            <li key={step.id}>
              <RunRow run={step} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t("noSteps")}</p>
      )}
    </section>
  );
}

// A step's numbers: its work, its items' outcomes, its requests and its proxy tests by outcome, and its proxies
function StepNumbers({ run }: { run: RunWithSteps }) {
  const t = useTranslations("activity");
  const locale = useLocale();
  const { step } = useRunTexts();
  const texts = step(run.step);
  const requestNames: Record<string, string> = useMessages().activity.requests;
  const numbers = run.numbers;
  const count = (value: number | undefined) => (value === undefined ? "—" : formatCount(value, locale));
  const brought = numberOf(numbers, "plain_brought_in_by");
  const processes = numberOf(numbers, "processes");
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("work")}</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={t("toDo", { items: texts.items ?? "" })} value={count(numberOf(numbers, "items"))} />
          <Stat label={t("done")} value={count(numberOf(numbers, "done"))} />
          <Stat label={texts.saved ?? t("saved")} value={count(numberOf(numbers, "saved"))} />
          <Stat label={t("processes")} value={count(processes)} />
          <Stat label={t("speed")} value={count(numberOf(numbers, "requests_per_second"))} />
          <Stat label={t("workingProxies")} value={count(numberOf(numbers, "working_proxies"))} />
        </dl>
      </section>
      <div className="grid gap-6 md:grid-cols-3">
        <Counts title={t("outcomesTitle")} counts={countsOf(numbers, "results")} names={texts.results ?? {}} />
        <Counts title={t("requestsTitle")} counts={countsOf(numbers, "requests")} names={requestNames} />
        <Counts title={t("proxyTestsTitle")} counts={countsOf(numbers, "proxy_tests")} names={requestNames} />
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("proxiesTitle")}</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label={t("vpnInReserve")} value={count(numberOf(numbers, "vpn_proxies"))} />
          <Stat label={t("plainInReserve")} value={count(numberOf(numbers, "plain_proxies"))} />
          <Stat
            label={t("plainBroughtIn")}
            value={brought === undefined ? "—" : `${formatCount(brought, locale)} / ${count(processes)}`}
          />
        </dl>
      </section>
    </div>
  );
}

// "uv run proxies"'s numbers: its VPN and plain lists, the unique configs and proxies by protocol, and sing-box's
function ProxiesNumbers({ numbers }: { numbers: Record<string, unknown> }) {
  const t = useTranslations("activity");
  const locale = useLocale();
  const count = (value: number | undefined) => (value === undefined ? "—" : formatCount(value, locale));
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t("proxiesTitle")}</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label={t("vpnListsTitle")} value={count(numberOf(numbers, "vpn", "lists"))} />
          <Stat label={t("uniqueConfigs")} value={count(numberOf(numbers, "vpn", "unique"))} />
          <Stat label={t("plainListsTitle")} value={count(numberOf(numbers, "plain", "lists"))} />
          <Stat label={t("uniqueProxies")} value={count(numberOf(numbers, "plain", "unique"))} />
          <Stat
            label={t("singboxProcesses")}
            value={count(numberOf(numbers, "singbox", "running"))}
            note={
              numberOf(numbers, "singbox", "processes") === undefined
                ? undefined
                : t("ofProcesses", { count: formatCount(numberOf(numbers, "singbox", "processes") ?? 0, locale) })
            }
          />
          <Stat label={t("localProxies")} value={count(numberOf(numbers, "singbox", "local_proxies"))} />
        </dl>
      </section>
      <div className="grid gap-6 md:grid-cols-2">
        <Counts title={t("byProtocol")} counts={countsOf(numbers, "vpn", "protocols")} names={{}} />
        <Counts title={t("byKind")} counts={countsOf(numbers, "plain", "kinds")} names={{}} />
      </div>
      <Lists title={t("vpnListsTitle")} lists={(numbers.vpn as { per_list?: unknown[] } | undefined)?.per_list} />
      <Lists title={t("plainListsTitle")} lists={(numbers.plain as { per_list?: unknown[] } | undefined)?.per_list} />
    </div>
  );
}

// A group of counts as a table: each one's name (from names, or as it is) and its number, the biggest first
function Counts({
  title,
  counts,
  names,
}: {
  title: string;
  counts: [string, number][];
  names: Record<string, string>;
}) {
  const locale = useLocale();
  if (!counts.length) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="rounded-xl border">
        <Table>
          <TableBody>
            {counts.map(([key, value]) => (
              <TableRow key={key}>
                <TableCell className="pl-4">{names[key] ?? key}</TableCell>
                <TableCell className="pr-4 text-right tabular-nums">{formatCount(value, locale)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

type ListNumbers = {
  list: string;
  updated?: string | null;
  found?: number;
  new?: number;
  skipped?: number;
  error?: string;
};

// One kind of proxy list, a row per list: when it last changed, what it had, how much of that no list above it had,
// and what couldn't be used; or why it couldn't be downloaded
function Lists({ title, lists }: { title: string; lists: unknown[] | undefined }) {
  const t = useTranslations("activity");
  const locale = useLocale();
  if (!lists?.length) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">{t("list")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("updated")}</TableHead>
              <TableHead className="text-right">{t("found")}</TableHead>
              <TableHead className="text-right">{t("new")}</TableHead>
              <TableHead className="hidden pr-4 text-right sm:table-cell">{t("skipped")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(lists as ListNumbers[]).map((row, index) => (
              <TableRow key={`${row.list}-${index}`}>
                <TableCell className="w-full max-w-0 truncate pl-4 font-mono text-xs" title={row.list}>
                  {row.list}
                </TableCell>
                {row.error ? (
                  <TableCell colSpan={4} className="pr-4 text-destructive">
                    {t("downloadFailed", { error: row.error })}
                  </TableCell>
                ) : (
                  <>
                    <TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">
                      {row.updated ? formatDateTime(row.updated, locale) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(row.found ?? 0, locale)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCount(row.new ?? 0, locale)}</TableCell>
                    <TableCell className="hidden pr-4 text-right tabular-nums sm:table-cell">
                      {formatCount(row.skipped ?? 0, locale)}
                    </TableCell>
                  </>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// The page's shape while the run loads
function DetailsSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, box) => (
          <Skeleton key={box} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
