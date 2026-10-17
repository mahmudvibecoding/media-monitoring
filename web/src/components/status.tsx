"use client";

import { useQuery } from "@tanstack/react-query";
import { MessageCircleIcon, MessageSquareTextIcon, SendIcon, TvIcon, VideoIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { statusOptions } from "@/api/@tanstack/react-query.gen";
import { ApiError } from "@/components/api-error";
import { YouTubeIcon } from "@/components/brand-icons";
import { Stat, Stats } from "@/components/stat";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount } from "@/lib/format";

const REFRESH_EVERY = 30_000; // milliseconds, while the tab is in view

// How much the database holds (GET /api/status), refreshed while the page is open. Once loaded, the numbers stay if a
// later refresh fails.
export function Status() {
  const t = useTranslations("status");
  const locale = useLocale();
  const { data, error, isFetching, refetch } = useQuery({ ...statusOptions(), refetchInterval: REFRESH_EVERY });
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <StatusSkeleton />;
  }
  const count = (value: number) => formatCount(value, locale);
  return (
    <div className="grid gap-6 lg:grid-cols-5">
      <Group title="YouTube" icon={<YouTubeIcon className="size-4" />} className="lg:col-span-3">
        <Stats className="sm:grid-cols-3">
          <Stat icon={TvIcon} label={t("youtube.channels")} value={count(data.youtube.channels)} />
          <Stat icon={VideoIcon} label={t("youtube.videos")} value={count(data.youtube.videos)} />
          <Stat icon={MessageCircleIcon} label={t("youtube.comments")} value={count(data.youtube.comments)} />
        </Stats>
      </Group>
      <Group title="Telegram" icon={<SendIcon className="size-4" />} className="lg:col-span-2">
        <Stats className="sm:grid-cols-2">
          <Stat icon={SendIcon} label={t("telegram.channels")} value={count(data.telegram.channels)} />
          <Stat icon={MessageSquareTextIcon} label={t("telegram.messages")} value={count(data.telegram.messages)} />
        </Stats>
      </Group>
    </div>
  );
}

function Group({
  title,
  icon,
  className,
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      <h2 className="mb-2 flex items-center gap-2 font-medium text-muted-foreground">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

// The numbers' shape while they load
function StatusSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="grid gap-6 lg:grid-cols-5" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="h-24 rounded-lg lg:col-span-3" />
      <Skeleton className="h-24 rounded-lg lg:col-span-2" />
    </div>
  );
}
