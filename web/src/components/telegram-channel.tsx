"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon,
  AtSignIcon,
  ClockIcon,
  InfoIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useRef, useState } from "react";

import { telegramChannelMessagesInfiniteOptions, telegramChannelOptions } from "@/api/@tanstack/react-query.gen";
import type { TelegramChannelDetails, TelegramMessage } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { ChannelPhoto, LinkedText } from "@/components/telegram-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { formatClock, formatCompact, formatCount, formatDateTime, formatDay, pluralOf, sameDay } from "@/lib/format";
import { FIRST_PAGE, nextPage } from "@/lib/pages";
import { channelOnTelegram, messageOnTelegram } from "@/lib/telegram";
import { useLoadMore } from "@/lib/use-load-more";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

// A channel's page, laid out like the channel in Telegram: a bar with its picture, name and subscribers; its saved
// messages as Telegram's bubbles on Telegram's chat background, the newest at the bottom, each day under its date,
// older ones loading as the chat is scrolled up; and beside it (on a phone, from the bar) the channel's info
export function TelegramChat({ id }: { id: number }) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  const [info, setInfo] = useState(false);
  const { data, error, isFetching, refetch } = useQuery(telegramChannelOptions({ path: { channel_id: id } }));
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <ChatSkeleton />;
  }
  const name = data.title?.trim() || `@${data.username}`;
  const subscribers =
    data.subscribers === null
      ? `@${data.username}`
      : t("subscribers", { count: pluralOf(data.subscribers), formatted: formatCompact(data.subscribers, locale) });
  return (
    // The whole height below the phone's bar, edge to edge: the page's margins are taken back
    <div className="relative -mx-4 -my-6 flex h-[calc(100svh-3rem)] font-roboto text-tg-text sm:-mx-8 md:h-svh">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-white px-2 sm:px-3">
          <Link
            href="/telegram/channels"
            aria-label={t("back")}
            className="rounded-full p-2 text-tg-muted hover:bg-tg-hover"
          >
            <ArrowLeftIcon className="size-5" />
          </Link>
          <button
            type="button"
            onClick={() => setInfo(true)}
            className="flex min-w-0 items-center gap-3 text-left lg:pointer-events-none"
          >
            <ChannelPhoto id={id} name={name} url={data.photo_url} size={40} />
            <span className="min-w-0">
              <span className="block truncate text-base font-medium">{name}</span>
              <span
                className="block truncate text-sm text-tg-muted"
                title={data.subscribers === null ? undefined : formatCount(data.subscribers, locale)}
              >
                {subscribers}
              </span>
            </span>
          </button>
          <a
            href={channelOnTelegram(data.username)}
            target="_blank"
            rel="noreferrer"
            className="ml-auto shrink-0 rounded-full px-3 py-2 text-sm font-medium text-tg-blue hover:bg-tg-blue/10"
          >
            {t("open")}
          </a>
        </header>
        <Messages id={id} username={data.username} />
      </section>
      <ChannelInfo channel={data} name={name} subscribers={subscribers} open={info} close={() => setInfo(false)} />
    </div>
  );
}

// The chat: the messages newest first in the page, shown bottom up (flex-direction: column-reverse), so it opens at
// the newest, as Telegram does, and older pages added at the end appear above without moving what's in view
function Messages({ id, username }: { id: number; username: string }) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  const now = useNow();
  const scroller = useRef<HTMLDivElement>(null);
  const { data, error, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch } = useInfiniteQuery({
    ...telegramChannelMessagesInfiniteOptions({ path: { channel_id: id } }),
    ...FIRST_PAGE,
    getNextPageParam: nextPage("messages"),
  });
  const marker = useLoadMore({
    more: !!hasNextPage,
    loading: isFetchingNextPage,
    load: fetchNextPage,
    root: scroller,
  });
  const messages = data?.pages.flatMap((page) => page.messages) ?? [];

  let content: ReactNode;
  if (!data) {
    content = error ? (
      <div className="m-auto">
        <ApiError error={error} retry={() => void refetch()} retrying={isFetching} />
      </div>
    ) : (
      <BubblesSkeleton />
    );
  } else if (messages.length === 0) {
    content = <DateChip>{t("none")}</DateChip>;
  } else {
    content = messages.flatMap((message, index) => {
      const older = messages[index + 1];
      const items = [<Bubble key={message.id} message={message} username={username} />];
      // Above each day's oldest message (after it, bottom up), the day
      if (!older || !sameDay(message.published_at, older.published_at)) {
        items.push(<DateChip key={`day-${message.id}`}>{formatDay(message.published_at, now, locale)}</DateChip>);
      }
      return items;
    });
  }

  return (
    <div ref={scroller} className="flex flex-1 flex-col-reverse overflow-y-auto bg-tg-chat px-2 py-3 sm:px-6">
      <div className="mx-auto flex w-full max-w-2xl flex-col-reverse gap-1.5">
        {content}
        <div ref={marker} />
        {isFetchingNextPage && <BubblesSkeleton rows={2} />}
      </div>
    </div>
  );
}

// A message as Telegram's bubble: its text, links in blue, and at the bottom right the time it came out, which opens
// it on Telegram. The time keeps its place after the last line (a blank as wide as it ends the text), as in Telegram.
function Bubble({ message, username }: { message: TelegramMessage; username: string }) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  return (
    <div className="relative max-w-[min(34rem,90%)] self-start rounded-2xl rounded-bl-md bg-tg-bubble px-3 pt-1.5 pb-2 shadow-[0_1px_2px_rgba(16,35,47,0.15)]">
      <p className="text-[15px] leading-[1.35] break-words whitespace-pre-wrap">
        <LinkedText text={message.text} />
        <span className="inline-block w-12" aria-hidden="true" />
      </p>
      <a
        href={messageOnTelegram(username, message.id)}
        target="_blank"
        rel="noreferrer"
        title={`${formatDateTime(message.published_at, locale)} · ${t("openMessage")}`}
        className="absolute right-3 bottom-1 text-xs text-tg-muted tabular-nums hover:underline"
      >
        {formatClock(message.published_at)}
      </a>
    </div>
  );
}

// A day's date over its messages, as Telegram's: a small dark rounded label in the middle, which stays at the top
// while that day's messages scroll by
function DateChip({ children }: { children: ReactNode }) {
  return (
    <div className="sticky top-1 z-10 my-2 self-center rounded-full bg-black/25 px-2.5 py-0.5 text-sm font-medium text-white">
      {children}
    </div>
  );
}

// The channel's info, as Telegram's panel beside a chat: its big picture, name and subscribers, then its description,
// its link, its latest post and the messages saved, each under its icon. On a phone, it comes over the chat from the
// bar, and closes with its button.
function ChannelInfo({
  channel,
  name,
  subscribers,
  open,
  close,
}: {
  channel: TelegramChannelDetails;
  name: string;
  subscribers: string;
  open: boolean;
  close: () => void;
}) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  return (
    <aside
      className={cn(
        "shrink-0 overflow-y-auto border-l bg-white",
        open ? "absolute inset-0 z-20 block" : "hidden",
        "lg:static lg:block lg:w-80",
      )}
    >
      <button
        type="button"
        onClick={close}
        aria-label={t("close")}
        className="m-2 rounded-full p-2 text-tg-muted hover:bg-tg-hover lg:hidden"
      >
        <XIcon className="size-5" />
      </button>
      <div className="flex flex-col items-center px-6 pt-6 pb-4 text-center lg:pt-10">
        <ChannelPhoto id={channel.id} name={name} url={channel.photo_url} size={120} />
        <h2 className="mt-4 text-xl font-medium break-words">{name}</h2>
        <p className="text-sm text-tg-muted">{subscribers}</p>
      </div>
      <div className="space-y-1 px-2 pb-6">
        {channel.description?.trim() && (
          <InfoRow icon={InfoIcon} label={t("info")}>
            <LinkedText text={channel.description.trim()} />
          </InfoRow>
        )}
        <InfoRow icon={AtSignIcon} label={t("link")}>
          <a href={channelOnTelegram(channel.username)} target="_blank" rel="noreferrer" className="text-tg-blue">
            t.me/{channel.username}
          </a>
        </InfoRow>
        {channel.last_message_at && (
          <InfoRow icon={ClockIcon} label={t("lastPost")}>
            {formatDateTime(channel.last_message_at, locale)}
          </InfoRow>
        )}
        <InfoRow icon={MessageSquareTextIcon} label={t("savedMessages")}>
          {formatCount(channel.messages, locale)}
        </InfoRow>
      </div>
    </aside>
  );
}

function InfoRow({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="flex gap-6 rounded-xl px-3 py-2.5 hover:bg-tg-hover">
      <Icon className="mt-0.5 size-6 shrink-0 text-tg-muted" strokeWidth={1.75} />
      <div className="min-w-0">
        <div className="text-[15px] break-words whitespace-pre-wrap">{children}</div>
        <div className="text-sm text-tg-muted">{label}</div>
      </div>
    </div>
  );
}

// The chat's shape while the channel loads
function ChatSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="-mx-4 -my-6 flex h-[calc(100svh-3rem)] flex-col sm:-mx-8 md:h-svh" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      <div className="flex h-14 items-center gap-3 border-b px-4">
        <Skeleton className="size-10 rounded-full" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="flex flex-1 flex-col-reverse bg-tg-chat p-6">
        <BubblesSkeleton />
      </div>
    </div>
  );
}

// Bubbles' shape while messages load
function BubblesSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="h-16 w-full max-w-md rounded-2xl rounded-bl-md bg-white/70" />
      ))}
    </div>
  );
}
