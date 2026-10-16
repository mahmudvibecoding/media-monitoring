"use client";

import { useQuery } from "@tanstack/react-query";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { statusOptions } from "@/api/@tanstack/react-query.gen";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const REFRESH_EVERY = 30_000; // milliseconds, while the tab is in view

// How much the database holds (GET /api/status), refreshed while the page is open
export function Status() {
  const t = useTranslations("status");
  const { data, isError } = useQuery({ ...statusOptions(), refetchInterval: REFRESH_EVERY });
  if (!data) {
    return <p className="text-muted-foreground">{t(isError ? "failed" : "loading")}</p>;
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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-3">{children}</div>
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  const format = useFormatter();
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{format.number(value)}</CardTitle>
      </CardHeader>
    </Card>
  );
}
