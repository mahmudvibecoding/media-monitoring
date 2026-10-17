"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";

import { telegramChannelsOptions } from "@/api/@tanstack/react-query.gen";
import type { TelegramChannel } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { Pages } from "@/components/pages";
import { SearchBox } from "@/components/search-box";
import { ChannelPhoto } from "@/components/telegram-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { go } from "@/lib/address";
import { formatChatDate, formatCompact, formatCount, formatDateTime, pluralOf } from "@/lib/format";
import { telegramChannelsAddress, telegramChannelsQuery } from "@/lib/telegram";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const ORDERS = ["subscribers", "latest"] as const;

// The monitored Telegram channels, as the address asks for them, a page at a time, laid out like Telegram's list of
// chats: a round picture, the name, @username and subscribers, and when the channel last posted. Searched as one types;
// the biggest first or the latest to post first, in tabs like Telegram's folders. While the next page loads, the last
// one stays, dimmed.
export function TelegramChannels() {
  const t = useTranslations("telegramChannels");
  const locale = useLocale();
  const query = telegramChannelsQuery(useSearchParams());
  const { data, error, isFetching, isPlaceholderData, refetch } = useQuery({
    ...telegramChannelsOptions({ query }),
    placeholderData: keepPreviousData,
  });
  const page = query.page ?? 1;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const { search, sort } = query;

  // Past the last page (an old link, or fewer channels since): the last page instead
  const pastTheEnd = !!data && !isPlaceholderData && data.total > 0 && data.channels.length === 0 && page > 1;
  useEffect(() => {
    if (pastTheEnd) go(telegramChannelsAddress({ search, sort, page: pages > 1 ? pages : undefined }), "replace");
  }, [pastTheEnd, search, sort, pages]);

  function turn(to: number) {
    go(telegramChannelsAddress({ search, sort, page: to > 1 ? to : undefined }), "push");
    window.scrollTo({ top: 0 });
  }

  const labels = { subscribers: t("biggest"), latest: t("latest") };
  let list;
  if (!data) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <ChatsSkeleton />;
  } else if (data.total === 0) {
    list = <p className="px-2 py-4 text-tg-muted">{search ? t("noMatch", { search }) : t("none")}</p>;
  } else {
    list = (
      <>
        <ul className={cn("transition-opacity", isPlaceholderData && "opacity-60")}>
          {data.channels.map((channel) => (
            <ChatRow key={channel.id} channel={channel} />
          ))}
        </ul>
        {pages > 1 && <Pages page={page} pages={pages} turn={turn} />}
      </>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3 font-roboto text-tg-text">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox
          look="telegram"
          search={search ?? ""}
          placeholder={t("search")}
          onSearch={(next) => go(telegramChannelsAddress({ search: next || undefined, sort }), "replace")}
        />
        {data && (
          <p className="ml-auto text-sm text-tg-muted tabular-nums">
            {search
              ? t("found", { formatted: formatCount(data.total, locale) })
              : t("count", { count: data.total, formatted: formatCount(data.total, locale) })}
          </p>
        )}
      </div>
      <nav className="flex gap-6 border-b px-2" aria-label={t("order")}>
        {ORDERS.map((order) => {
          const active = (sort ?? "subscribers") === order;
          return (
            <button
              key={order}
              type="button"
              aria-current={active ? "true" : undefined}
              onClick={() =>
                go(telegramChannelsAddress({ search, sort: order === "subscribers" ? undefined : order }), "push")
              }
              className={cn(
                "relative h-11 text-[15px] font-medium",
                active ? "text-tg-blue" : "text-tg-muted hover:text-tg-text",
              )}
            >
              {labels[order]}
              {active && <span className="absolute inset-x-0 bottom-0 h-[3px] rounded-t-full bg-tg-blue" />}
            </button>
          );
        })}
      </nav>
      {list}
    </div>
  );
}

// A channel as Telegram lists a chat: its picture, its name with when it last posted at the right (the time today,
// the weekday this week, the date before), and its @username and subscribers below. The whole row opens the channel's
// page here (not fetched ahead: 50 rows would mean 50 requests).
function ChatRow({ channel }: { channel: TelegramChannel }) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  const now = useNow();
  const name = channel.title?.trim() || `@${channel.username}`;
  const subscribers =
    channel.subscribers === null
      ? null
      : t("subscribers", {
          count: pluralOf(channel.subscribers),
          formatted: formatCompact(channel.subscribers, locale),
        });
  return (
    <li className="relative flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-tg-hover">
      <ChannelPhoto id={channel.id} name={name} url={channel.photo_url} size={54} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Link
            href={`/telegram/channels/${channel.id}`}
            prefetch={false}
            className="min-w-0 truncate text-base font-medium after:absolute after:inset-0"
          >
            {name}
          </Link>
          {channel.last_message_at && (
            <time
              dateTime={channel.last_message_at}
              title={formatDateTime(channel.last_message_at, locale)}
              className="ml-auto shrink-0 text-xs text-tg-muted tabular-nums"
            >
              {formatChatDate(channel.last_message_at, now, locale)}
            </time>
          )}
        </div>
        <p className="truncate text-[15px] text-tg-muted">
          @{channel.username}
          {subscribers && (
            <span title={channel.subscribers === null ? undefined : formatCount(channel.subscribers, locale)}>
              {" · "}
              {subscribers}
            </span>
          )}
        </p>
      </div>
    </li>
  );
}

// The list's shape while its first channels load
function ChatsSkeleton() {
  const t = useTranslations("common");
  return (
    <div aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: 10 }, (_, row) => (
        <div key={row} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="size-[54px] rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}
