"use client";

import { Dialog } from "@base-ui/react/dialog";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { GlobeIcon, type LucideIcon, SquarePlayIcon, UserRoundIcon, XIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";

import { youtubeChannelOptions, youtubeChannelVideosInfiniteOptions } from "@/api/@tanstack/react-query.gen";
import type { YouTubeChannelDetails } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { Skeleton } from "@/components/ui/skeleton";
import { YouTubeText } from "@/components/youtube-text";
import { ChannelPicture, Dot, ShortCard, VideoCard, YT_ICON_BUTTON } from "@/components/youtube-ui";
import { go } from "@/lib/address";
import { formatCompact, formatCount, pluralOf } from "@/lib/format";
import { FIRST_PAGE, nextPage } from "@/lib/pages";
import { useLoadMore } from "@/lib/use-load-more";
import { cn } from "@/lib/utils";
import { firstKind, handleOnYouTube, type Kind, SORTS, videosAddress, videosQuery } from "@/lib/youtube";

const KINDS: Kind[] = ["video", "short"];

// The top of a channel's page, as YouTube's: its big round picture, its name, then its handle, subscribers and videos
// on one line, and the first line of its description ending in "…more", which opens the channel's About box
export function ChannelDetails({ id }: { id: string }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  const [about, setAbout] = useState(false);
  const { data, error, isFetching, refetch } = useQuery(youtubeChannelOptions({ path: { channel_id: id } }));
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <DetailsSkeleton />;
  }
  const name = data.title?.trim() || data.id; // the ID until the channel's details are fetched
  const description = data.description?.trim();
  return (
    <section className="flex items-center gap-4 pt-4 font-roboto text-yt-text sm:items-start">
      <ChannelPicture url={data.avatar_url} size={160} className="size-[72px]! sm:size-40!" />
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl leading-8 font-bold break-words sm:text-4xl sm:leading-[50px]">{name}</h1>
        <p className="mt-0.5 text-sm leading-5 text-yt-muted">
          {data.handle && <span className="font-medium whitespace-nowrap text-yt-text">{data.handle}</span>}
          {data.handle && <Dot />}
          <span
            className="whitespace-nowrap"
            title={data.subscribers === null ? undefined : formatCount(data.subscribers, locale)}
          >
            {data.subscribers === null
              ? t("subscribersHidden")
              : t("subscribers", {
                  count: pluralOf(data.subscribers),
                  formatted: formatCompact(data.subscribers, locale),
                })}
          </span>
          <Dot />
          <span className="whitespace-nowrap" title={formatCount(data.videos.all, locale)}>
            {t("videoCount", { count: pluralOf(data.videos.all), formatted: formatCompact(data.videos.all, locale) })}
          </span>
        </p>
        <button
          type="button"
          onClick={() => setAbout(true)}
          className="mt-3 flex w-full max-w-[600px] text-left text-sm leading-5 text-yt-muted"
        >
          <span className="overflow-hidden text-clip whitespace-nowrap">
            {description ? description.split("\n")[0] : t("moreAbout")}
          </span>
          <span className="shrink-0 font-medium text-yt-text">{t("more")}</span>
        </button>
      </div>
      <About channel={data} name={name} open={about} onOpenChange={setAbout} />
    </section>
  );
}

// The channel's About box, as YouTube's: its description, with YouTube's links, then its details, each by its icon:
// its address on YouTube, and its exact subscribers and videos
function About({
  channel,
  name,
  open,
  onOpenChange,
}: {
  channel: YouTubeChannelDetails;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("youtubeChannel");
  const youtube = useTranslations("youtube");
  const locale = useLocale();
  const description = channel.description?.trim();
  const address = channel.handle ? `www.youtube.com/${channel.handle}` : `www.youtube.com/channel/${channel.id}`;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(720px,calc(100dvh-48px))] w-[min(584px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white font-roboto text-yt-text shadow-[0_4px_32px_rgba(0,0,0,0.1)] outline-none">
          <div className="flex items-center justify-between gap-4 py-3 pr-3 pl-6">
            <Dialog.Title className="truncate text-xl leading-7 font-bold">{t("about")}</Dialog.Title>
            <Dialog.Close aria-label={youtube("close")} className={YT_ICON_BUTTON}>
              <XIcon className="size-6" />
            </Dialog.Close>
          </div>
          <div className="overflow-y-auto px-6 pb-6">
            <Dialog.Description className="sr-only">{name}</Dialog.Description>
            {description && (
              <>
                <h3 className="text-xl leading-7 font-bold">{t("description")}</h3>
                <p className="mt-3 text-sm leading-5 break-words whitespace-pre-wrap">
                  <YouTubeText text={description} />
                </p>
              </>
            )}
            <h3 className={cn("text-xl leading-7 font-bold", description && "mt-8")}>{t("details")}</h3>
            <ul className="mt-2 text-sm leading-5">
              <Fact icon={GlobeIcon}>
                <a
                  href={channel.handle ? handleOnYouTube(channel.handle) : `https://${address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="break-all hover:underline"
                >
                  {address}
                </a>
              </Fact>
              {channel.subscribers !== null && (
                <Fact icon={UserRoundIcon}>
                  {t("subscribers", {
                    count: channel.subscribers,
                    formatted: formatCount(channel.subscribers, locale),
                  })}
                </Fact>
              )}
              <Fact icon={SquarePlayIcon}>
                {t("videoCount", { count: channel.videos.all, formatted: formatCount(channel.videos.all, locale) })}
              </Fact>
            </ul>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Fact({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <li className="flex min-h-10 items-center gap-4">
      <Icon className="size-6 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

// The channel's videos in YouTube's tabs (its Videos and its Shorts, each only when it has some; the address says
// which: ?kind=…), YouTube's chips for the order (newest, most viewed, oldest: ?sort=…) and its grid of covers, upright
// for Shorts. More load as the grid is scrolled down, as on YouTube; while another tab or order loads, the grid that
// was there stays, dimmed.
export function ChannelVideos({ id }: { id: string }) {
  const t = useTranslations("youtubeChannel");
  const counts = useQuery(youtubeChannelOptions({ path: { channel_id: id } })).data?.videos;
  const first = firstKind(counts);
  const query = videosQuery(useSearchParams(), first);
  const kind: Kind = query.kind === "short" ? "short" : "video";
  const sort = query.sort ?? "newest";
  const { data, error, isFetching, isFetchingNextPage, isPlaceholderData, hasNextPage, fetchNextPage, refetch } =
    useInfiniteQuery({
      ...youtubeChannelVideosInfiniteOptions({ path: { channel_id: id }, query }),
      ...FIRST_PAGE,
      getNextPageParam: nextPage("videos"),
      placeholderData: keepPreviousData,
    });
  const marker = useLoadMore({ more: !!hasNextPage, loading: isFetchingNextPage, load: fetchNextPage });
  const videos = data?.pages.flatMap((page) => page.videos) ?? [];
  const tabs = KINDS.filter((option) => option === kind || !counts || counts[option] > 0);
  const labels: Record<Kind, string> = { video: t("videos"), short: t("shorts") };

  let list;
  if (!data) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <GridSkeleton />;
  } else if (videos.length === 0) {
    list = <p className="text-sm text-yt-muted">{t("none")}</p>;
  } else {
    list = (
      <>
        <ul
          className={cn(
            "grid transition-opacity",
            isPlaceholderData && "opacity-60",
            kind === "short"
              ? "grid-cols-2 gap-x-1 gap-y-6 @min-[600px]:grid-cols-3 @min-[800px]:grid-cols-4 @min-[1000px]:grid-cols-5 @min-[1200px]:grid-cols-6"
              : "grid-cols-1 gap-x-4 gap-y-8 @min-[500px]:grid-cols-2 @min-[860px]:grid-cols-3 @min-[1200px]:grid-cols-4",
          )}
        >
          {videos.map((video) =>
            kind === "short" ? (
              <ShortCard key={video.id} video={video} sort={query.sort} />
            ) : (
              <VideoCard key={video.id} video={video} />
            ),
          )}
        </ul>
        <div ref={marker} />
        {isFetchingNextPage && <GridSkeleton rows={1} />}
      </>
    );
  }

  return (
    <section className="@container font-roboto text-yt-text">
      <nav className="flex border-b border-yt-divider" aria-label={t("videos")}>
        {tabs.map((option) => (
          <button
            key={option}
            type="button"
            aria-current={option === kind ? "page" : undefined}
            onClick={() => option !== kind && go(videosAddress({ kind: option }, first), "push")}
            className={cn(
              "relative mr-6 flex h-12 items-center text-base leading-[22px] font-medium",
              option === kind
                ? "text-yt-text after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-yt-text"
                : "text-yt-muted hover:text-yt-text",
            )}
          >
            {labels[option]}
          </button>
        ))}
      </nav>
      <div className="flex gap-2 pt-4 pb-6">
        {SORTS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === sort}
            onClick={() =>
              option !== sort &&
              go(videosAddress({ kind, sort: option === "newest" ? undefined : option }, first), "push")
            }
            className={cn(
              "h-8 rounded-lg px-3 text-sm leading-5 font-medium",
              option === sort ? "bg-yt-text text-white" : "bg-yt-chip text-yt-text hover:bg-yt-chip-hover",
            )}
          >
            {t(`sorts.${option}`)}
          </button>
        ))}
      </div>
      {list}
    </section>
  );
}

// The top's shape while the channel's details load
function DetailsSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="flex items-center gap-4 pt-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="size-[72px] rounded-full sm:size-40" />
      <div className="space-y-3">
        <Skeleton className="h-9 w-72 max-w-full" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
    </div>
  );
}

// The grid's shape while its videos load
function GridSkeleton({ rows = 2 }: { rows?: number }) {
  const t = useTranslations("common");
  return (
    <div
      className="mt-8 grid grid-cols-1 gap-x-4 gap-y-8 @min-[500px]:grid-cols-2 @min-[860px]:grid-cols-3 @min-[1200px]:grid-cols-4"
      aria-busy="true"
    >
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
