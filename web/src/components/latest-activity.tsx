"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { latestRunsOptions } from "@/api/@tanstack/react-query.gen";
import { LIVE_EVERY } from "@/components/activity";
import { OutcomeBadge, RunRow, useRunTexts } from "@/components/runs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { secondsOf } from "@/lib/activity";
import { formatDateTime, formatSeconds } from "@/lib/format";

// On the overview: the last round, and every step going now, asked for again every few seconds, so a run that starts
// shows up
export function LatestActivity() {
  const t = useTranslations("activity.overview");
  const locale = useLocale();
  const { name } = useRunTexts();
  const { data } = useQuery({ ...latestRunsOptions(), refetchInterval: LIVE_EVERY });
  if (!data) return null; // the counts above say whether the API answers
  const { round, running } = data;
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-medium">{t("title")}</h2>
        <Link href="/activity" className="text-sm text-muted-foreground hover:text-foreground hover:underline">
          {t("all")}
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("lastRound")}</CardTitle>
          </CardHeader>
          <CardContent>
            {round ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link href={`/activity/${round.id}`} className="font-medium hover:underline">
                  {name(round)}
                </Link>
                <OutcomeBadge outcome={round.outcome} />
                <span className="text-sm text-muted-foreground tabular-nums">
                  {formatDateTime(round.started_at, locale)} · {formatSeconds(secondsOf(round), locale)}
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("noRounds")}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("runningNow")}</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {running.length ? (
              <ul className="-my-3 divide-y">
                {running.map((run) => (
                  <li key={run.id}>
                    <RunRow run={run} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 text-sm text-muted-foreground">{t("nothingRunning")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
