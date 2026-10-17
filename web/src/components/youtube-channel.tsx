"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";

import { youtubeChannelOptions, youtubeChannelVideosOptions } from "@/api/@tanstack/react-query.gen";
import type { YouTubeVideo } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { FoldedText } from "@/components/folded-text";
import { Pages } from "@/components/pages";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { go } from "@/lib/address";
import { formatCount, formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { avatarAt, channelOnYouTube, thumbnail, videoOnYouTube, videosAddress, videosQuery } from "@/lib/youtube";

const AVATAR_SIZE = 176; // pixels: twice what the page shows, for sharp screens
const KINDS = ["all", "video", "short"] as const;
type Kind = (typeof KINDS)[number];

// The top of a channel's page: its picture, name, handle, subscribers and description, and a link to it on YouTube
export function ChannelDetails({ id }: { id: string }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  const { data, error, isFetching, refetch } = useQuery(youtubeChannelOptions({ path: { channel_id: id } }));
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <DetailsSkeleton />;
  }
  const name = data.title?.trim() || data.id; // the ID until the channel's details are fetched
  const subscribers =
    data.subscribers === null
      ? t("subscribersHidden")
      : t("subscribers", { count: data.subscribers, formatted: formatCount(data.subscribers, locale) });
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar className="size-16">
          {data.avatar_url && (
            <AvatarImage src={avatarAt(data.avatar_url, AVATAR_SIZE)} alt="" referrerPolicy="no-referrer" />
          )}
          <AvatarFallback className="text-2xl">{Array.from(name)[0]?.toUpperCase()}</AvatarFallback>
        </Avatar>
        {/* At least 15rem wide beside the picture: on a phone, the YouTube button goes to the next line instead */}
        <div className="min-w-0 flex-1 basis-60">
          <h1 className="text-2xl font-semibold break-words">{name}</h1>
          <p className="text-muted-foreground">{data.handle ? `${data.handle} · ${subscribers}` : subscribers}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<a href={channelOnYouTube(id)} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon />
          {t("open")}
        </Button>
      </div>
      {data.description?.trim() && (
        <div className="max-w-3xl">
          <FoldedText text={data.description.trim()} lines={3} className="text-sm text-muted-foreground" />
        </div>
      )}
    </section>
  );
}

// The channel's videos, newest first, a page at a time: all of them, or only videos, or only Shorts, as the address
// asks for (?kind=short&page=2). How many there are, for the tabs and the pages, comes with the channel's details.
// While the next page loads, the last one stays, dimmed.
export function ChannelVideos({ id }: { id: string }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  const query = videosQuery(useSearchParams());
  const counts = useQuery(youtubeChannelOptions({ path: { channel_id: id } })).data?.videos;
  const { data, error, isFetching, isPlaceholderData, refetch } = useQuery({
    ...youtubeChannelVideosOptions({ path: { channel_id: id }, query }),
    placeholderData: keepPreviousData,
  });
  const { kind, page = 1 } = query;
  const total = counts?.[kind ?? "all"];
  let pages = page; // without the channel's counts (they failed to load), a full page means there's another
  if (data)
    pages =
      total !== undefined
        ? Math.max(1, Math.ceil(total / data.page_size))
        : page + Number(data.videos.length === data.page_size);

  // Past the last page (an old link, or fewer videos since): the last page instead
  const pastTheEnd = !!data && !isPlaceholderData && data.videos.length === 0 && page > 1;
  useEffect(() => {
    if (pastTheEnd) go(videosAddress({ kind, page: pages > 1 && pages < page ? pages : undefined }), "replace");
  }, [pastTheEnd, kind, page, pages]);

  function turn(to: number) {
    go(videosAddress({ kind, page: to > 1 ? to : undefined }), "push");
    window.scrollTo({ top: 0 });
  }

  const labels: Record<Kind, string> = { all: t("all"), video: t("videos"), short: t("shorts") };
  let list;
  if (!data) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <VideosSkeleton />;
  } else if (data.videos.length === 0) {
    list = page === 1 && <p className="text-muted-foreground">{t("none")}</p>;
  } else {
    list = (
      <>
        <div className={cn("rounded-xl border transition-opacity", isPlaceholderData && "opacity-60")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t("video")}</TableHead>
                <TableHead className="text-right">{t("views")}</TableHead>
                <TableHead className="hidden text-right sm:table-cell">{t("likes")}</TableHead>
                <TableHead className="hidden pr-4 text-right sm:table-cell">{t("comments")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.videos.map((video) => (
                <VideoRow key={video.id} video={video} />
              ))}
            </TableBody>
          </Table>
        </div>
        {pages > 1 && <Pages page={page} pages={pages} turn={turn} />}
      </>
    );
  }

  return (
    <section className="space-y-4">
      <Tabs
        value={kind ?? "all"}
        onValueChange={(value) =>
          go(videosAddress({ kind: value === "video" || value === "short" ? value : undefined }), "push")
        }
      >
        <TabsList>
          {KINDS.map((option) => (
            <TabsTrigger key={option} value={option}>
              {labels[option]}
              {counts && (
                <span className="text-muted-foreground tabular-nums">{formatCount(counts[option], locale)}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {list}
    </section>
  );
}

function VideoRow({ video }: { video: YouTubeVideo }) {
  const t = useTranslations("youtubeChannel");
  const locale = useLocale();
  const count = (value: number | null) => (value === null ? "—" : formatCount(value, locale));
  return (
    <TableRow className={cn(!video.available && "text-muted-foreground")}>
      {/* The video takes the room the numbers leave, its title in up to two lines. It opens the video's page here (not
          fetched ahead, as 50 rows would mean 50 requests), and the icon after it, YouTube's. */}
      <TableCell className="w-full max-w-0 pl-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/youtube/videos/${video.id}`}
            prefetch={false}
            className="group flex min-w-0 flex-1 items-center gap-3"
          >
            {/* Straight from YouTube: Next's image optimizer would fetch it through the site's server, which can't
              reach the internet */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnail(video.id)}
              alt=""
              width={320}
              height={180}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="aspect-video w-24 shrink-0 rounded-md bg-muted object-cover sm:w-30"
            />
            <span className="min-w-0 space-y-1">
              <span className="line-clamp-2 font-medium whitespace-normal group-hover:underline">
                {video.title?.trim() || video.id}
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                {video.published_at && <span>{formatDateTime(video.published_at, locale)}</span>}
                {video.duration !== null && <span className="tabular-nums">{formatDuration(video.duration)}</span>}
                {video.kind === "short" && <Badge variant="secondary">{t("short")}</Badge>}
                {!video.available && <Badge variant="outline">{t("unavailable")}</Badge>}
              </span>
            </span>
          </Link>
          <a
            href={videoOnYouTube(video.id)}
            target="_blank"
            rel="noreferrer"
            title={t("watch")}
            aria-label={t("watch")}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{count(video.views)}</TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">{count(video.likes)}</TableCell>
      <TableCell className="hidden pr-4 text-right tabular-nums sm:table-cell">{count(video.comments)}</TableCell>
    </TableRow>
  );
}

// The page's shape while the channel's details load
function DetailsSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="flex items-center gap-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="size-16 rounded-full" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-40" />
      </div>
    </div>
  );
}

// The list's shape while its first videos load
function VideosSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="space-y-3 rounded-xl border p-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: 8 }, (_, row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton className="aspect-video w-24 rounded-md sm:w-30" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-72 max-w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
