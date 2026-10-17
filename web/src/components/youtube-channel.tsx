"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { youtubeChannelOptions, youtubeChannelVideosInfiniteOptions } from "@/api/@tanstack/react-query.gen";
import { ApiError } from "@/components/api-error";
import { FoldedText } from "@/components/folded-text";
import { Skeleton } from "@/components/ui/skeleton";
import { ChannelPicture, ShortCard, VideoCard, YT_BUTTON } from "@/components/youtube-ui";
import { go } from "@/lib/address";
import { formatCompact, formatCount, pluralOf } from "@/lib/format";
import { FIRST_PAGE, nextPage } from "@/lib/pages";
import { useLoadMore } from "@/lib/use-load-more";
import { cn } from "@/lib/utils";
import { channelOnYouTube, videosAddress, videosQuery } from "@/lib/youtube";

const KINDS = ["all", "video", "short"] as const;
type Kind = (typeof KINDS)[number];

// The top of a channel's page, as YouTube's: its big round picture, its name, handle, subscribers and videos, the
// first line of its description (the rest on asking), and a button to it on YouTube where YouTube has Subscribe
export function ChannelDetails({ id }: { id: string }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  const { data, error, isFetching, refetch } = useQuery(youtubeChannelOptions({ path: { channel_id: id } }));
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <DetailsSkeleton />;
  }
  const name = data.title?.trim() || data.id; // the ID until the channel's details are fetched
  const facts = [
    data.subscribers === null
      ? t("subscribersHidden")
      : t("subscribers", { count: pluralOf(data.subscribers), formatted: formatCompact(data.subscribers, locale) }),
    t("videoCount", { count: pluralOf(data.videos.all), formatted: formatCompact(data.videos.all, locale) }),
  ];
  return (
    <section className="flex flex-col gap-4 font-roboto text-yt-text sm:flex-row sm:items-center sm:gap-6">
      <ChannelPicture url={data.avatar_url} size={160} className="size-24! sm:size-40!" />
      <div className="min-w-0 flex-1 space-y-2">
        <h1 className="text-2xl font-bold break-words sm:text-4xl">{name}</h1>
        <p className="text-sm text-yt-muted">
          {data.handle && <span className="font-medium text-yt-text">{data.handle}</span>}
          {data.handle && " · "}
          <span title={data.subscribers === null ? undefined : formatCount(data.subscribers, locale)}>
            {facts.join(" · ")}
          </span>
        </p>
        {data.description?.trim() && (
          <FoldedText
            text={data.description.trim()}
            lines={1}
            className="max-w-3xl text-sm text-yt-muted"
            buttonClassName="font-medium text-yt-text no-underline hover:no-underline"
          />
        )}
        <a href={channelOnYouTube(id)} target="_blank" rel="noreferrer" className={cn(YT_BUTTON, "mt-1")}>
          <ExternalLinkIcon className="size-4" />
          {t("open")}
        </a>
      </div>
    </section>
  );
}

// The channel's videos, newest first, in YouTube's tabs (all of them, only videos, or only Shorts, as the address
// asks: ?kind=short) and its grid of covers, upright for Shorts. More load as the grid is scrolled down, as on
// YouTube; how many there are, for the tabs, comes with the channel's details.
export function ChannelVideos({ id }: { id: string }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  const query = videosQuery(useSearchParams());
  const counts = useQuery(youtubeChannelOptions({ path: { channel_id: id } })).data?.videos;
  const { data, error, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useInfiniteQuery({
    ...youtubeChannelVideosInfiniteOptions({ path: { channel_id: id }, query }),
    ...FIRST_PAGE,
    getNextPageParam: nextPage("videos"),
  });
  const marker = useLoadMore({ more: !!hasNextPage, loading: isFetchingNextPage, load: fetchNextPage });
  const kind: Kind = query.kind ?? "all";
  const videos = data?.pages.flatMap((page) => page.videos) ?? [];
  const labels: Record<Kind, string> = { all: t("all"), video: t("videos"), short: t("shorts") };

  let list;
  if (!data) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <GridSkeleton />;
  } else if (videos.length === 0) {
    list = <p className="text-yt-muted">{t("none")}</p>;
  } else {
    list = (
      <>
        <ul
          className={
            kind === "short"
              ? "grid grid-cols-2 gap-x-1 gap-y-6 sm:grid-cols-3 sm:gap-x-4 lg:grid-cols-4 xl:grid-cols-6"
              : "grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          }
        >
          {videos.map((video) =>
            kind === "short" ? <ShortCard key={video.id} video={video} /> : <VideoCard key={video.id} video={video} />,
          )}
        </ul>
        <div ref={marker} />
        {isFetchingNextPage && <GridSkeleton rows={1} />}
      </>
    );
  }

  return (
    <section className="font-roboto text-yt-text">
      <nav className="mb-6 flex gap-6 border-b border-yt-line" aria-label={t("videos")}>
        {KINDS.map((option) => (
          <button
            key={option}
            type="button"
            aria-current={option === kind ? "page" : undefined}
            onClick={() =>
              go(videosAddress({ kind: option === "video" || option === "short" ? option : undefined }), "push")
            }
            className={cn(
              "-mb-px flex h-12 items-center gap-1.5 border-b-2 text-base font-medium",
              option === kind ? "border-yt-text text-yt-text" : "border-transparent text-yt-muted hover:text-yt-text",
            )}
          >
            {labels[option]}
            {counts && (
              <span
                className="text-sm font-normal text-yt-muted tabular-nums"
                title={formatCount(counts[option], locale)}
              >
                {formatCompact(counts[option], locale)}
              </span>
            )}
          </button>
        ))}
      </nav>
      {list}
    </section>
  );
}

// The top's shape while the channel's details load
function DetailsSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="flex items-center gap-6" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="size-24 rounded-full sm:size-40" />
      <div className="space-y-3">
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-9 w-40 rounded-full" />
      </div>
    </div>
  );
}

// The grid's shape while its videos load
function GridSkeleton({ rows = 2 }: { rows?: number }) {
  const t = useTranslations("common");
  return (
    <div className="mt-8 grid gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: rows * 4 }, (_, card) => (
        <div key={card} className="space-y-3">
          <Skeleton className="aspect-video rounded-xl" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
