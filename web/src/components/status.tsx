"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { statusOptions } from "@/api/@tanstack/react-query.gen";
import { ApiError } from "@/components/api-error";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount } from "@/lib/format";

const REFRESH_EVERY = 30_000; // milliseconds, while the tab is in view

// How much the database holds (GET /api/status), refreshed while the page is open. Once loaded, the numbers stay if a
// later refresh fails.
export function Status() {
  const t = useTranslations("status");
  const { data, error, isFetching, refetch } = useQuery({ ...statusOptions(), refetchInterval: REFRESH_EVERY });
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <StatusSkeleton />;
  }
  return (
    <div className="space-y-8">
      <Group title="YouTube">
        <Count label={t("youtube.channels")} value={data.youtube.channels} />
        <Count label={t("youtube.videos")} value={data.youtube.videos} />
        <Count label={t("youtube.comments")} value={data.youtube.comments} />
      </Group>
      <Group title="Telegram">
        <Count label={t("telegram.channels")} value={data.telegram.channels} />
        <Count label={t("telegram.messages")} value={data.telegram.messages} />
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-3">{children}</div>
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  const locale = useLocale();
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{formatCount(value, locale)}</CardTitle>
      </CardHeader>
    </Card>
  );
}

// The cards' shape while their numbers load: three for YouTube, two for Telegram
function StatusSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="space-y-8" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {[3, 2].map((cards) => (
        <Group key={cards} title={<Skeleton className="h-7 w-24" />}>
          {Array.from({ length: cards }, (_, card) => (
            <Skeleton key={card} className="h-22 rounded-xl" />
          ))}
        </Group>
      ))}
    </div>
  );
}
