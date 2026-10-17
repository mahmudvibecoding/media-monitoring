"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { EyeIcon, MessageCircleIcon, ThumbsUpIcon, UserIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef } from "react";

import {
  youtubeChannelVideosOptions,
  youtubeVideoCommentsInfiniteOptions,
  youtubeVideoOptions,
} from "@/api/@tanstack/react-query.gen";
import type { YouTubeComment } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { FoldedText } from "@/components/folded-text";
import { Skeleton } from "@/components/ui/skeleton";
import { When } from "@/components/when";
import { ChannelPicture, SmallVideoCard, YouTubeMasthead, YT_PILL } from "@/components/youtube-ui";
import { formatCompact, formatCount, formatDateTime, formatWhen, pluralOf } from "@/lib/format";
import { FIRST_PAGE, nextPage } from "@/lib/pages";
import { useLoadMore } from "@/lib/use-load-more";
import { channelOnYouTube } from "@/lib/youtube";

// A video's page, laid out like YouTube's: YouTube's header (up is the video's channel), its player, the title, the channel with its picture and subscribers, the counts in YouTube's pills, the description in its grey box,
// and the comments; beside it, more from the same channel
export function VideoPage({ id }: { id: string }) {
  const channel = useQuery(youtubeVideoOptions({ path: { video_id: id } })).data?.channel_id;
  return (
    // As YouTube's watch page: the player up to 1280 px wide, and beside it a column of 402 px
    <div className="mx-auto max-w-[1706px] space-y-6">
      <YouTubeMasthead up={channel ? `/youtube/channels/${channel}` : "/youtube/channels"} />
      <div className="grid gap-6 font-roboto text-yt-text xl:grid-cols-[minmax(0,1fr)_402px]">
        <div className="min-w-0 space-y-6">
          <VideoDetails id={id} />
          <VideoComments id={id} />
        </div>
        <MoreFromChannel id={id} />
      </div>
    </div>
  );
}

function VideoDetails({ id }: { id: string }) {
  const t = useTranslations("youtubeVideo");
  const channelTexts = useTranslations("youtubeChannel");
  const locale = useLocale();
  const { data, error, isFetching, refetch } = useQuery(youtubeVideoOptions({ path: { video_id: id } }));
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <DetailsSkeleton />;
  }
  const channel = data.channel_title?.trim() || data.channel_id;
  const pill = (icon: ReactNode, value: number | null, label: string) =>
    value === null ? null : (
      <span className={YT_PILL} title={`${label}: ${formatCount(value, locale)}`}>
        {icon}
        <span className="tabular-nums">{formatCompact(value, locale, true)}</span>
        <span className="sr-only">{label}</span>
      </span>
    );
  return (
    <section className="space-y-3">
      <Player id={id} title={data.title?.trim() || id} />
      <h1 className="text-xl leading-7 font-bold break-words">{data.title?.trim() || data.id}</h1>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Link href={`/youtube/channels/${data.channel_id}`} className="flex min-w-0 items-center gap-3">
          <ChannelPicture url={data.channel_avatar_url} size={40} />
          <span className="min-w-0">
            <span className="block truncate text-base font-medium">{channel}</span>
            {data.channel_subscribers !== null && (
              <span className="block text-xs text-yt-muted" title={formatCount(data.channel_subscribers, locale)}>
                {channelTexts("subscribers", {
                  count: pluralOf(data.channel_subscribers),
                  formatted: formatCompact(data.channel_subscribers, locale),
                })}
              </span>
            )}
          </span>
        </Link>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {pill(<ThumbsUpIcon className="size-4" />, data.likes, t("likes"))}
          {pill(<MessageCircleIcon className="size-4" />, data.comments, t("comments"))}
        </div>
      </div>
      <div className="space-y-1 rounded-xl bg-yt-chip p-3 text-sm">
        <p className="flex flex-wrap items-center gap-x-2 font-medium">
          {data.views !== null && (
            <span className="inline-flex items-center gap-1" title={t("views")}>
              <EyeIcon className="size-4" />
              {formatCount(data.views, locale)}
            </span>
          )}
          {data.published_at && <When iso={data.published_at} youtube />}
          {data.kind === "short" && <span className="text-yt-muted">#Shorts</span>}
          {!data.available && <span className="text-yt-muted">{t("unavailable")}</span>}
        </p>
        {data.description?.trim() && (
          <FoldedText
            text={data.description.trim()}
            lines={3}
            buttonClassName="font-medium text-yt-text no-underline hover:no-underline"
          />
        )}
        <p className="pt-1 text-xs text-yt-muted">
          {data.stats_updated_at
            ? t("statsAsOf", { when: formatDateTime(data.stats_updated_at, locale) })
            : t("noStats")}
        </p>
      </div>
    </section>
  );
}

const PLAYER = "https://www.youtube-nocookie.com"; // YouTube's privacy-enhanced address for its player

// The player's address for a video: playing it at once, from a second if given
const embed = (id: string, from = 0) =>
  `${PLAYER}/embed/${id}?autoplay=1&rel=0&enablejsapi=1${from > 0 ? `&start=${from}` : ""}`;

// The video, played here by YouTube's own player, which starts it as the page opens (with sound once one has clicked
// anything on the site, as browsers allow; without, the player waits for a click). YouTube wants to know which site
// the player is on (the address this page sends with the request), so unlike the pictures it isn't asked for without
// one. Next keeps a page one has left alive, hidden, for going back to it: as the page goes, the player is unloaded,
// so that nothing goes on playing there, unseen, and as it comes back, loaded again, from the second it had got to.
// That second is what the player tells a page that has said it's listening.
function Player({ id, title }: { id: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const position = useRef(0); // seconds into the video, as the player last said
  useEffect(() => {
    const player = frame.current;
    if (!player) return;
    const listen = () =>
      player.contentWindow?.postMessage(JSON.stringify({ event: "listening", id, channel: "widget" }), PLAYER);
    function heard(event: MessageEvent) {
      if (event.source !== player?.contentWindow || typeof event.data !== "string") return;
      try {
        const time = JSON.parse(event.data)?.info?.currentTime;
        if (typeof time === "number") position.current = time;
      } catch {
        // not the player's message
      }
    }
    window.addEventListener("message", heard);
    player.addEventListener("load", listen);
    if (player.src === "about:blank")
      player.src = embed(id, Math.floor(position.current)); // back on the page
    else listen(); // in case it loaded already
    return () => {
      window.removeEventListener("message", heard);
      player.removeEventListener("load", listen);
      player.src = "about:blank";
    };
  }, [id]);
  return (
    <div className="relative aspect-video overflow-hidden rounded-xl bg-black">
      <iframe
        ref={frame}
        src={embed(id)}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        className="absolute inset-0 size-full"
      />
    </div>
  );
}

// The collected comments, newest first, as YouTube lists them: the author, when, whether it was edited, and the text,
// folded after four lines. More load as the list is scrolled down. Their number comes with the video's details.
function VideoComments({ id }: { id: string }) {
  const t = useTranslations("youtubeVideo");
  const locale = useLocale();
  const video = useQuery(youtubeVideoOptions({ path: { video_id: id } })).data;
  const { data, error, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useInfiniteQuery({
    ...youtubeVideoCommentsInfiniteOptions({ path: { video_id: id } }),
    ...FIRST_PAGE,
    getNextPageParam: nextPage("comments"),
  });
  const marker = useLoadMore({ more: !!hasNextPage, loading: isFetchingNextPage, load: fetchNextPage });
  const comments = data?.pages.flatMap((page) => page.comments) ?? [];

  let list;
  if (!data) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <CommentsSkeleton />;
  } else if (comments.length === 0) {
    list = <p className="text-yt-muted">{t("none")}</p>;
  } else {
    list = (
      <>
        <ul className="space-y-6">
          {comments.map((comment) => (
            <Comment key={comment.id} comment={comment} />
          ))}
        </ul>
        <div ref={marker} />
        {isFetchingNextPage && <CommentsSkeleton rows={2} />}
      </>
    );
  }

  return (
    <section className="space-y-6">
      {video && (
        <h2 className="text-xl font-bold">
          {t("commentCount", {
            count: video.comments_collected,
            formatted: formatCount(video.comments_collected, locale),
          })}
        </h2>
      )}
      {list}
    </section>
  );
}

// A comment, as YouTube shows it: a round picture (a figure: YouTube doesn't give the authors' pictures with their
// comments), the author (their channel on YouTube), how long ago, as precisely as YouTube said it, and the text
function Comment({ comment }: { comment: YouTubeComment }) {
  const t = useTranslations("youtubeVideo");
  const locale = useLocale();
  const author = comment.author_name?.trim() || "—";
  return (
    <li className="flex gap-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-yt-chip">
        <UserIcon className="size-5 text-yt-muted" strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px]">
          {comment.author_channel_id ? (
            <a
              href={channelOnYouTube(comment.author_channel_id)}
              target="_blank"
              rel="noreferrer"
              className="font-medium break-all"
            >
              {author}
            </a>
          ) : (
            <span className="font-medium break-all">{author}</span>
          )}
          {comment.written_at && (
            <When
              iso={comment.written_at}
              youtube
              title={formatWhen(comment.written_at, comment.precision, locale)}
              className="text-xs text-yt-muted"
            />
          )}
          {comment.edited && <span className="text-xs text-yt-muted">({t("edited")})</span>}
        </p>
        {comment.text && (
          <FoldedText
            text={comment.text}
            lines={4}
            className="mt-0.5 text-sm leading-5"
            buttonClassName="font-medium text-yt-muted no-underline hover:text-yt-text hover:no-underline"
          />
        )}
      </div>
    </li>
  );
}

// Beside the video, as YouTube's next ones: the channel's newest videos (its first page, the same the channel's page
// asks for), without this one
function MoreFromChannel({ id }: { id: string }) {
  const t = useTranslations("youtubeVideo");
  const video = useQuery(youtubeVideoOptions({ path: { video_id: id } })).data;
  const { data } = useQuery({
    ...youtubeChannelVideosOptions({ path: { channel_id: video?.channel_id ?? "" } }),
    enabled: !!video,
  });
  if (!video || !data) return null;
  const others = data.videos.filter((other) => other.id !== id).slice(0, 20);
  if (!others.length) return null;
  const channel = video.channel_title?.trim() || video.channel_id;
  return (
    <aside className="space-y-3">
      <h2 className="text-base font-medium">{t("moreFrom", { channel })}</h2>
      <ul className="space-y-2">
        {others.map((other) => (
          <SmallVideoCard key={other.id} video={other} channel={channel} />
        ))}
      </ul>
    </aside>
  );
}

// The page's shape while the video's details load
function DetailsSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="space-y-3" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="aspect-video rounded-xl" />
      <Skeleton className="h-7 w-full max-w-2xl" />
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <Skeleton className="h-4 w-48" />
      </div>
    </div>
  );
}

// The comments' shape while they load
function CommentsSkeleton({ rows = 6 }: { rows?: number }) {
  const t = useTranslations("common");
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-4">
          <Skeleton className="size-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </div>
        </div>
      ))}
    </div>
  );
}
