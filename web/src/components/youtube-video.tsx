"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { youtubeVideoCommentsOptions, youtubeVideoOptions } from "@/api/@tanstack/react-query.gen";
import type { YouTubeComment } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { FoldedText } from "@/components/folded-text";
import { Pages } from "@/components/pages";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { go } from "@/lib/address";
import { formatCount, formatDateTime, formatDuration, formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { channelOnYouTube, commentsAddress, commentsQuery, thumbnail, videoOnYouTube } from "@/lib/youtube";

// The top of a video's page: its cover, title, channel and dates, a link to it on YouTube, its numbers, and its
// description
export function VideoDetails({ id }: { id: string }) {
  const t = useTranslations("youtubeVideo");
  const locale = useLocale();
  const { data, error, isFetching, refetch } = useQuery(youtubeVideoOptions({ path: { video_id: id } }));
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <DetailsSkeleton />;
  }
  const count = (value: number | null) => (value === null ? "—" : formatCount(value, locale));
  return (
    <section className="space-y-5">
      <div className="flex flex-wrap gap-5">
        {/* Straight from YouTube: Next's image optimizer would fetch it through the site's server, which can't reach
            the internet. The 16:9 frame cuts off the black bars of the 480 × 360 cover. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={thumbnail(id, "hq")}
          alt=""
          width={480}
          height={360}
          referrerPolicy="no-referrer"
          className="aspect-video w-full rounded-lg bg-muted object-cover sm:w-80"
        />
        <div className="min-w-0 flex-1 basis-72 space-y-3">
          <h1 className="text-xl font-semibold break-words">{data.title?.trim() || data.id}</h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <Link href={`/youtube/channels/${data.channel_id}`} className="font-medium text-foreground hover:underline">
              {data.channel_title?.trim() || data.channel_id}
            </Link>
            {data.published_at && <span>{formatDateTime(data.published_at, locale)}</span>}
            {data.duration !== null && <span className="tabular-nums">{formatDuration(data.duration)}</span>}
            {data.kind === "short" && <Badge variant="secondary">{t("short")}</Badge>}
            {!data.available && <Badge variant="outline">{t("unavailable")}</Badge>}
          </p>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<a href={videoOnYouTube(id)} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon />
            {t("watch")}
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t("views")} value={count(data.views)} />
          <Stat label={t("likes")} value={count(data.likes)} />
          <Stat label={t("comments")} value={count(data.comments)} />
          <Stat
            label={t("collected")}
            value={formatCount(data.comments_collected, locale)}
            note={data.comments_complete ? t("complete") : t("incomplete")}
          />
        </dl>
        <p className="text-xs text-muted-foreground">
          {data.stats_updated_at
            ? t("statsAsOf", { when: formatDateTime(data.stats_updated_at, locale) })
            : t("noStats")}
        </p>
      </div>
      {data.description?.trim() && (
        <div className="max-w-3xl">
          <FoldedText text={data.description.trim()} lines={3} className="text-sm text-muted-foreground" />
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border p-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}

// The video's collected comments, newest first, a page at a time, as the address asks for (?page=2). How many there
// are, for the pages, comes with the video's details. While the next page loads, the last one stays, dimmed.
export function VideoComments({ id }: { id: string }) {
  const t = useTranslations("youtubeVideo");
  const query = commentsQuery(useSearchParams());
  const total = useQuery(youtubeVideoOptions({ path: { video_id: id } })).data?.comments_collected;
  const { data, error, isFetching, isPlaceholderData, refetch } = useQuery({
    ...youtubeVideoCommentsOptions({ path: { video_id: id }, query }),
    placeholderData: keepPreviousData,
  });
  const section = useRef<HTMLElement>(null);
  const page = query.page ?? 1;
  let pages = page; // without the video's count (it failed to load), a full page means there's another
  if (data) {
    pages =
      total !== undefined
        ? Math.max(1, Math.ceil(total / data.page_size))
        : page + Number(data.comments.length === data.page_size);
  }

  // Past the last page (an old link, or fewer comments since): the last page instead
  const pastTheEnd = !!data && !isPlaceholderData && data.comments.length === 0 && page > 1;
  useEffect(() => {
    if (pastTheEnd) go(commentsAddress({ page: pages > 1 && pages < page ? pages : undefined }), "replace");
  }, [pastTheEnd, page, pages]);

  // A new page of comments starts at their heading, not at the top of the video's page
  function turn(to: number) {
    go(commentsAddress({ page: to > 1 ? to : undefined }), "push");
    section.current?.scrollIntoView({ block: "start" });
  }

  let list;
  if (!data) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <CommentsSkeleton />;
  } else if (data.comments.length === 0) {
    list = page === 1 && <p className="text-muted-foreground">{t("none")}</p>;
  } else {
    list = (
      <>
        <ul className={cn("divide-y rounded-xl border px-4 transition-opacity", isPlaceholderData && "opacity-60")}>
          {data.comments.map((comment) => (
            <Comment key={comment.id} comment={comment} />
          ))}
        </ul>
        {pages > 1 && <Pages page={page} pages={pages} turn={turn} />}
      </>
    );
  }

  return (
    <section ref={section} className="scroll-mt-4 space-y-4">
      <h2 className="text-lg font-semibold">{t("commentsTitle")}</h2>
      {list}
    </section>
  );
}

// A comment: its author (their channel on YouTube), when it was written, as precisely as YouTube said it, whether it
// was edited, and its text, folded after six lines
function Comment({ comment }: { comment: YouTubeComment }) {
  const t = useTranslations("youtubeVideo");
  const locale = useLocale();
  const author = comment.author_name?.trim() || "—";
  return (
    <li className="space-y-1 py-3">
      <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
        {comment.author_channel_id ? (
          <a
            href={channelOnYouTube(comment.author_channel_id)}
            target="_blank"
            rel="noreferrer"
            className="font-medium break-all hover:underline"
          >
            {author}
          </a>
        ) : (
          <span className="font-medium break-all">{author}</span>
        )}
        {comment.written_at && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatWhen(comment.written_at, comment.precision, locale)}
          </span>
        )}
        {comment.edited && <span className="text-xs text-muted-foreground">{t("edited")}</span>}
      </p>
      {comment.text && <FoldedText text={comment.text} lines={6} className="text-sm" />}
    </li>
  );
}

// The page's shape while the video's details load
function DetailsSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="flex flex-wrap gap-5" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <Skeleton className="aspect-video w-full rounded-lg sm:w-80" />
      <div className="flex-1 basis-72 space-y-3">
        <Skeleton className="h-7 w-full max-w-md" />
        <Skeleton className="h-4 w-60" />
      </div>
    </div>
  );
}

// The comments' shape while the first of them load
function CommentsSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="space-y-4 rounded-xl border p-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: 6 }, (_, row) => (
        <div key={row} className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-full max-w-xl" />
        </div>
      ))}
    </div>
  );
}
