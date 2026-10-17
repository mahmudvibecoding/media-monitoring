"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { latestRunsOptions } from "@/api/@tanstack/react-query.gen";
import { LIVE_EVERY } from "@/components/activity";
import { RunRow } from "@/components/runs";

// On the overview: the last round, and every step going now, asked for again every few seconds, so a run that starts
// shows up. Each opens its page wherever it's clicked.
export function LatestActivity() {
  const t = useTranslations("activity.overview");
  const { data } = useQuery({ ...latestRunsOptions(), refetchInterval: LIVE_EVERY });
  if (!data) return null; // the counts above say whether the API answers
  const { round, running } = data;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="font-medium text-muted-foreground">{t("title")}</h2>
        <Link href="/activity" className="inline-flex items-center text-muted-foreground hover:text-foreground">
          {t("all")}
          <ChevronRightIcon className="size-4" />
        </Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel title={t("lastRound")}>
          {round ? <RunRow run={round} /> : <p className="px-4 py-3 text-muted-foreground">{t("noRounds")}</p>}
        </Panel>
        <Panel title={t("runningNow")}>
          {running.length ? (
            <ul className="divide-y">
              {running.map((run) => (
                <li key={run.id}>
                  <RunRow run={run} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-muted-foreground">{t("nothingRunning")}</p>
          )}
        </Panel>
      </div>
    </section>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <h3 className="border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}
