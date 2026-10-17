"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";

import { youtubeVideoCommentsInfiniteOptions } from "@/api/@tanstack/react-query.gen";
import type { YouTubeComment } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { Skeleton } from "@/components/ui/skeleton";
import { When } from "@/components/when";
import { YouTubeText } from "@/components/youtube-text";
import { formatWhen } from "@/lib/format";
import { FIRST_PAGE, nextPage } from "@/lib/pages";
import { useLoadMore } from "@/lib/use-load-more";
import { cn } from "@/lib/utils";
import { channelOnYouTube } from "@/lib/youtube";

// A video's collected comments, newest first, as YouTube lists them (owner: the video's channel, whose own comments
// YouTube marks). More load as the list is scrolled down: the page, or scroller, a box that scrolls by itself (a
// Short's comments' panel).
export function CommentList({
  id,
  owner,
  scroller,
}: {
  id: string;
  owner?: string;
  scroller?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("youtubeVideo");
  const { data, error, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useInfiniteQuery({
    ...youtubeVideoCommentsInfiniteOptions({ path: { video_id: id } }),
    ...FIRST_PAGE,
    getNextPageParam: nextPage("comments"),
  });
  const marker = useLoadMore({ more: !!hasNextPage, loading: isFetchingNextPage, load: fetchNextPage, root: scroller });
  const comments = data?.pages.flatMap((page) => page.comments) ?? [];
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <CommentsSkeleton />;
  }
  if (comments.length === 0) return <p className="text-sm text-yt-muted">{t("none")}</p>;
  return (
    <>
      <ul>
        {comments.map((comment) => (
          <Comment key={comment.id} comment={comment} owner={owner} />
        ))}
      </ul>
      <div ref={marker} />
      {isFetchingNextPage && <CommentsSkeleton rows={2} />}
    </>
  );
}

// The colors YouTube puts behind the letter of someone without a picture
const LETTER_COLORS = [
  "#ef6c00",
  "#5c6bc0",
  "#7cb342",
  "#c2185b",
  "#00897b",
  "#f4511e",
  "#039be5",
  "#8e24aa",
  "#3949ab",
  "#00acc1",
  "#43a047",
  "#e53935",
  "#6d4c41",
  "#546e7a",
  "#fb8c00",
  "#d81b60",
];

// The same color for the same author, every time: picked by their channel's ID (or their name)
function colorOf(key: string): string {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) | 0;
  return LETTER_COLORS[Math.abs(hash) % LETTER_COLORS.length] ?? LETTER_COLORS[0]!;
}

// A comment, as YouTube shows it, in its sizes: a round picture, which is the author's first letter on a color of their
// own (YouTube doesn't give the authors' pictures with their comments, and shows the letter for those without one), the
// author (their channel on YouTube; the video's own channel in a grey pill, as YouTube marks it), how long ago, as
// precisely as YouTube said it, and whether it was edited; then the text, in four lines at most until it's opened
function Comment({ comment, owner }: { comment: YouTubeComment; owner?: string }) {
  const t = useTranslations("youtubeVideo");
  const locale = useLocale();
  const author = comment.author_name?.trim() || "—";
  const letter = (author.replace(/^@/, "").match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  const channels = !!comment.author_channel_id && comment.author_channel_id === owner;
  const name = cn("mr-1 font-medium break-all", channels && "rounded-full bg-yt-chip-hover px-1.5");
  return (
    <li className="mb-4 flex">
      <span
        aria-hidden="true"
        className="mr-4 flex size-9 shrink-0 items-center justify-center rounded-full text-lg text-white select-none"
        style={{ backgroundColor: colorOf(comment.author_channel_id ?? author) }}
      >
        {letter}
      </span>
      <div className="min-w-0 flex-1">
        <p className="mb-0.5 flex flex-wrap items-center text-xs leading-[18px]">
          {comment.author_channel_id ? (
            <a href={channelOnYouTube(comment.author_channel_id)} target="_blank" rel="noreferrer" className={name}>
              {author}
            </a>
          ) : (
            <span className={name}>{author}</span>
          )}
          {comment.written_at && (
            <When
              iso={comment.written_at}
              youtube
              title={formatWhen(comment.written_at, comment.precision, locale)}
              className="text-yt-muted"
            />
          )}
          {comment.edited && <span className="ml-1 text-yt-muted">({t("edited")})</span>}
        </p>
        {comment.text && <CommentText text={comment.text} />}
      </div>
    </li>
  );
}

// A comment's text, with YouTube's links, kept to four lines, and YouTube's "Read more" under it when it's longer (as
// the browser finds once it has laid it out)
function CommentText({ text }: { text: string }) {
  const t = useTranslations("youtubeVideo");
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const box = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || open) return;
    const measure = () => setLong(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);
  return (
    <>
      <p ref={box} className={cn("text-sm leading-5 break-words whitespace-pre-wrap", !open && "line-clamp-4")}>
        <YouTubeText text={text} />
      </p>
      {(long || open) && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1 text-sm leading-5 font-medium text-yt-muted"
        >
          {open ? t("readLess") : t("readMore")}
        </button>
      )}
    </>
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
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </div>
        </div>
      ))}
    </div>
  );
}
