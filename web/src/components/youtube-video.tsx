"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

import { youtubeChannelVideosInfiniteOptions, youtubeVideoOptions } from "@/api/@tanstack/react-query.gen";
import type { YouTubeVideoDetails } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { Skeleton } from "@/components/ui/skeleton";
import { When } from "@/components/when";
import { CommentList } from "@/components/youtube-comments";
import { PLAYER_MAX, WATCH_GRID } from "@/components/youtube-ghosts";
import { Player, PlayerProvider } from "@/components/youtube-player";
import { ShareButton } from "@/components/youtube-share";
import { hashtagsOf, YouTubeText } from "@/components/youtube-text";
import { ChannelPicture, SmallVideoCard, YouTubeLink } from "@/components/youtube-ui";
import { formatCompact, formatCount, formatDateTime, formatYouTubeDate, pluralOf } from "@/lib/format";
import { FIRST_PAGE, nextPage } from "@/lib/pages";
import { useLoadMore } from "@/lib/use-load-more";
import { cn } from "@/lib/utils";
import { hashtagOnYouTube } from "@/lib/youtube";

// From this width (the page's, in px) the next videos go beside the video, as on YouTube (see WATCH_GRID)
const TWO_COLUMNS = 1000;
const NARROW_SIDE = 20; // the next videos shown on a narrow screen, between the description and the comments

// A video's page, laid out like YouTube's watch page: the player, the title, the channel, the like and share buttons
// and the description, then the comments; beside them, more from the channel, which load on as they're scrolled (on a
// narrow screen, a few of them, under the description, before the comments, as on YouTube). The player is as wide as
// its column, but no taller than leaves room under it for the title on the screen, and the columns stay together in
// the middle of the page, as on YouTube.
export function VideoPage({ id }: { id: string }) {
  const box = useRef<HTMLDivElement>(null);
  const wide = useWidth(box) >= TWO_COLUMNS;
  return (
    <PlayerProvider>
      <div ref={box} className="@container px-4 pt-3 pb-10">
        <div className={WATCH_GRID} style={PLAYER_MAX}>
          <div className="min-w-0 [grid-area:main]">
            <VideoDetails id={id} />
          </div>
          <div className="min-w-0 [grid-area:side]">
            <MoreFromChannel id={id} endless={wide} />
          </div>
          <div className="min-w-0 [grid-area:comments]">
            <VideoComments id={id} />
          </div>
        </div>
      </div>
    </PlayerProvider>
  );
}

// A box's width, followed as the window changes (0 until it's measured, in the browser)
function useWidth(box: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [box]);
  return width;
}

// The video and what's said of it, as under YouTube's player: the title in two lines at most (all of it on hover), the
// channel with its picture and subscribers, the like and share buttons at the right, and the description's grey box
function VideoDetails({ id }: { id: string }) {
  const channelTexts = useTranslations("youtubeChannel");
  const locale = useLocale();
  const { data, error, isFetching, refetch } = useQuery(youtubeVideoOptions({ path: { video_id: id } }));
  // The next video, for the player's ⏭: the first of those beside it (the same list, from the cache)
  const others = useInfiniteQuery({
    ...youtubeChannelVideosInfiniteOptions({ path: { channel_id: data?.channel_id ?? "" }, query: { kind: "video" } }),
    ...FIRST_PAGE,
    getNextPageParam: nextPage("videos"),
    enabled: !!data,
  }).data;
  const following = others?.pages.flatMap((page) => page.videos).find((other) => other.id !== id && other.available);
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <DetailsSkeleton />;
  }
  const title = data.title?.trim() || data.id;
  const channel = data.channel_title?.trim() || data.channel_id;
  return (
    <section>
      <Player
        id={id}
        title={title}
        next={following && { id: following.id, title: following.title?.trim() || following.id }}
      />
      <h1 className="mt-3 line-clamp-2 text-xl leading-7 font-bold break-words" title={title}>
        {title}
      </h1>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        <YouTubeLink href={`/youtube/channels/${data.channel_id}`} className="flex min-w-0 items-center gap-3">
          <ChannelPicture url={data.channel_avatar_url} size={40} />
          <span className="min-w-0">
            <span className="block truncate text-base leading-[22px] font-medium">{channel}</span>
            {data.channel_subscribers !== null && (
              <span
                className="block text-xs leading-[18px] text-yt-muted"
                title={formatCount(data.channel_subscribers, locale)}
              >
                {channelTexts("subscribers", {
                  count: pluralOf(data.channel_subscribers),
                  formatted: formatCompact(data.channel_subscribers, locale),
                })}
              </span>
            )}
          </span>
        </YouTubeLink>
        <div className="flex items-center gap-2">
          <Likes likes={data.likes} />
          <ShareButton id={data.id} short={data.kind === "short"} />
        </div>
      </div>
      <Description video={data} />
    </section>
  );
}

// YouTube's like and dislike pill, which only shows here (nothing changes on a click): the likes by the thumb, cut
// short (the exact number on hover; "Like" when the video hides them), a line, and the thumb down, whose count YouTube
// keeps to itself
function Likes({ likes }: { likes: number | null }) {
  const t = useTranslations("youtubeVideo");
  const locale = useLocale();
  return (
    <div
      className="flex h-10 shrink-0 items-center rounded-full bg-yt-chip text-sm font-medium"
      title={likes === null ? undefined : `${t("likes")}: ${formatCount(likes, locale)}`}
    >
      <span className="relative flex h-full items-center gap-1.5 px-4 after:absolute after:top-2 after:right-0 after:h-6 after:w-px after:bg-yt-divider">
        <ThumbsUpIcon className="size-6" aria-hidden="true" />
        {likes === null ? t("like") : formatCompact(likes, locale, true)}
      </span>
      <span className="flex h-full w-14 items-center justify-center" aria-hidden="true">
        <ThumbsDownIcon className="size-6" />
      </span>
    </div>
  );
}

// The description, in YouTube's grey box: the views and how long ago (in bold), the first hashtags, then three lines
// of the text, the last ending in "…more"; a click anywhere on the box opens it, with the exact views and the day, all
// of the text, when the views and likes were read, and "Show less". Its links are YouTube's: addresses, hashtags,
// handles, and times, which take the player there.
function Description({ video }: { video: YouTubeVideoDetails }) {
  const t = useTranslations("youtubeVideo");
  const channelTexts = useTranslations("youtubeChannel");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const text = video.description?.trim() ?? "";
  const tags = video.title?.includes("#") ? [] : hashtagsOf(text).slice(0, 3);
  let views = null;
  if (video.views !== null) {
    views = open
      ? channelTexts("viewCount", { count: video.views, formatted: formatCount(video.views, locale) })
      : channelTexts("viewCount", {
          count: pluralOf(video.views),
          formatted: formatCompact(video.views, locale, true),
        });
  }
  return (
    <div
      onClick={open ? undefined : () => setOpen(true)}
      className={cn(
        "mt-3 rounded-xl bg-yt-chip p-3 text-sm leading-5",
        !open && "cursor-pointer hover:bg-yt-chip-hover",
      )}
    >
      <p className="flex flex-wrap gap-x-2 font-medium">
        {views && <span>{views}</span>}
        {video.published_at &&
          (open ? (
            <span>{formatYouTubeDate(video.published_at, locale)}</span>
          ) : (
            <When iso={video.published_at} youtube="short" />
          ))}
        {!video.available && <span>{t("unavailable")}</span>}
        {tags.map((tag) => (
          <a
            key={tag}
            href={hashtagOnYouTube(tag.slice(1))}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="text-yt-blue"
          >
            {tag}
          </a>
        ))}
      </p>
      {open ? (
        <>
          {text && (
            <p className="break-words whitespace-pre-wrap">
              <YouTubeText text={text} />
            </p>
          )}
          <p className="mt-3 text-xs leading-[18px] text-yt-muted">
            {video.stats_updated_at
              ? t("statsAsOf", { when: formatDateTime(video.stats_updated_at, locale) })
              : t("noStats")}
          </p>
          <button type="button" onClick={() => setOpen(false)} className="mt-5 font-medium">
            {t("less")}
          </button>
        </>
      ) : (
        // Three lines at most, and "…more" at the end of the last: an empty float as tall as the text but a line pushes
        // the button, floated after it, down to the last line's right end, and the text runs round it
        <div className="flex">
          <div className="max-h-[60px] overflow-hidden break-words whitespace-pre-wrap before:float-right before:h-[calc(100%-20px)] before:content-['']">
            <button type="button" aria-expanded={false} className="float-right clear-both font-medium">
              {t("more")}
            </button>
            <YouTubeText text={text} />
          </div>
        </div>
      )}
    </div>
  );
}

// The collected comments, newest first, as YouTube lists them, under their number, which comes with the video's
// details
function VideoComments({ id }: { id: string }) {
  const t = useTranslations("youtubeVideo");
  const locale = useLocale();
  const video = useQuery(youtubeVideoOptions({ path: { video_id: id } })).data;
  return (
    <section>
      {video && (
        <h2 className="mb-8 text-xl leading-7 font-bold">
          {t("commentCount", {
            count: video.comments_collected,
            formatted: formatCount(video.comments_collected, locale),
          })}
        </h2>
      )}
      <CommentList id={id} owner={video?.channel_id} />
    </section>
  );
}

// Beside the video, as YouTube's next ones: the channel's videos, newest first (the same list the channel's page shows
// first), without this one; more load as they're scrolled, but on a narrow screen, where the comments come after them
function MoreFromChannel({ id, endless }: { id: string; endless: boolean }) {
  const video = useQuery(youtubeVideoOptions({ path: { video_id: id } })).data;
  const { data, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    ...youtubeChannelVideosInfiniteOptions({
      path: { channel_id: video?.channel_id ?? "" },
      query: { kind: "video" },
    }),
    ...FIRST_PAGE,
    getNextPageParam: nextPage("videos"),
    enabled: !!video,
  });
  const marker = useLoadMore({ more: endless && !!hasNextPage, loading: isFetchingNextPage, load: fetchNextPage });
  if (!video || !data) return null;
  const others = data.pages.flatMap((page) => page.videos).filter((other) => other.id !== id);
  const shown = endless ? others : others.slice(0, NARROW_SIDE);
  if (!shown.length) return null;
  const channel = video.channel_title?.trim() || video.channel_id;
  return (
    <aside>
      <ul className="space-y-2">
        {shown.map((other) => (
          <SmallVideoCard key={other.id} video={other} channel={channel} />
        ))}
      </ul>
      {endless && <div ref={marker} />}
      {isFetchingNextPage && <SideSkeleton />}
    </aside>
  );
}

// The page's shape while the video's details load
function DetailsSkeleton() {
  const t = useTranslations("common");
  return (
    <div aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="aspect-video rounded-xl" />
      <Skeleton className="mt-3 h-7 w-full max-w-2xl" />
      <div className="mt-3 flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="mt-3 h-24 rounded-xl" />
    </div>
  );
}

// More videos' shape beside the video while they load
function SideSkeleton() {
  return (
    <div className="mt-2 space-y-2" aria-busy="true">
      {Array.from({ length: 3 }, (_, row) => (
        <div key={row} className="flex gap-3">
          <Skeleton className="aspect-video w-[min(248px,58%)] shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
