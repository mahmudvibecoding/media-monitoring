"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { telegramChannelMessagesOptions, telegramChannelOptions } from "@/api/@tanstack/react-query.gen";
import type { TelegramMessage } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { FoldedText } from "@/components/folded-text";
import { Pages } from "@/components/pages";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { go } from "@/lib/address";
import { formatCount, formatDateTime, initialOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { channelOnTelegram, messageOnTelegram, messagesAddress, messagesQuery } from "@/lib/telegram";

// The top of a Telegram channel's page: its name, username, subscribers, latest post and description, and a link to it
// on Telegram
export function TelegramChannelDetails({ id }: { id: number }) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  const { data, error, isFetching, refetch } = useQuery(telegramChannelOptions({ path: { channel_id: id } }));
  if (!data) {
    return error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <DetailsSkeleton />;
  }
  const name = data.title?.trim() || `@${data.username}`;
  const subscribers =
    data.subscribers === null
      ? null
      : t("subscribers", { count: data.subscribers, formatted: formatCount(data.subscribers, locale) });
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Avatar className="size-16">
          <AvatarFallback className="text-2xl">{initialOf(name)}</AvatarFallback>
        </Avatar>
        {/* At least 15rem wide beside the picture: on a phone, the Telegram button goes to the next line instead */}
        <div className="min-w-0 flex-1 basis-60">
          <h1 className="text-2xl font-semibold break-words">{name}</h1>
          <p className="text-muted-foreground">{[`@${data.username}`, subscribers].filter(Boolean).join(" · ")}</p>
          {data.last_message_at && (
            <p className="text-sm text-muted-foreground">
              {t("latestPost", { when: formatDateTime(data.last_message_at, locale) })}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<a href={channelOnTelegram(data.username)} target="_blank" rel="noreferrer" />}
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

// The channel's saved messages, newest first, a page at a time, as the address asks for (?page=2). How many there are,
// for the pages, comes with the channel's details. While the next page loads, the last one stays, dimmed.
export function TelegramChannelMessages({ id }: { id: number }) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  const query = messagesQuery(useSearchParams());
  const channel = useQuery(telegramChannelOptions({ path: { channel_id: id } })).data;
  const { data, error, isFetching, isPlaceholderData, refetch } = useQuery({
    ...telegramChannelMessagesOptions({ path: { channel_id: id }, query }),
    placeholderData: keepPreviousData,
  });
  const section = useRef<HTMLElement>(null);
  const page = query.page ?? 1;
  const total = channel?.messages;
  let pages = page; // without the channel's count (it failed to load), a full page means there's another
  if (data) {
    pages =
      total !== undefined
        ? Math.max(1, Math.ceil(total / data.page_size))
        : page + Number(data.messages.length === data.page_size);
  }

  // Past the last page (an old link, or fewer messages since): the last page instead
  const pastTheEnd = !!data && !isPlaceholderData && data.messages.length === 0 && page > 1;
  useEffect(() => {
    if (pastTheEnd) go(messagesAddress({ page: pages > 1 && pages < page ? pages : undefined }), "replace");
  }, [pastTheEnd, page, pages]);

  // A new page of messages starts at their heading, not at the top of the channel's page
  function turn(to: number) {
    go(messagesAddress({ page: to > 1 ? to : undefined }), "push");
    section.current?.scrollIntoView({ block: "start" });
  }

  let list;
  if (!data) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <MessagesSkeleton />;
  } else if (data.messages.length === 0) {
    list = page === 1 && <p className="text-muted-foreground">{t("none")}</p>;
  } else {
    list = (
      <>
        <ul className={cn("divide-y rounded-xl border px-4 transition-opacity", isPlaceholderData && "opacity-60")}>
          {data.messages.map((message) => (
            <Message key={message.id} message={message} username={channel?.username} />
          ))}
        </ul>
        {pages > 1 && <Pages page={page} pages={pages} turn={turn} />}
      </>
    );
  }

  return (
    <section ref={section} className="scroll-mt-4 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h2 className="text-lg font-semibold">{t("messagesTitle")}</h2>
        {total !== undefined && (
          <p className="text-sm text-muted-foreground tabular-nums">
            {t("saved", { count: total, formatted: formatCount(total, locale) })}
          </p>
        )}
      </div>
      {list}
    </section>
  );
}

// A message: when it came out, a link to it on Telegram (once the channel's username is known), and its text, folded
// after six lines
function Message({ message, username }: { message: TelegramMessage; username?: string }) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  return (
    <li className="space-y-1 py-3">
      <p className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
        {formatDateTime(message.published_at, locale)}
        {username && (
          <a
            href={messageOnTelegram(username, message.id)}
            target="_blank"
            rel="noreferrer"
            title={t("openMessage")}
            aria-label={t("openMessage")}
            className="hover:text-foreground"
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        )}
      </p>
      <FoldedText text={message.text} lines={6} className="text-sm" />
    </li>
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

// The messages' shape while the first of them load
function MessagesSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="space-y-4 rounded-xl border p-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: 6 }, (_, row) => (
        <div key={row} className="space-y-2">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-4 w-full max-w-md" />
        </div>
      ))}
    </div>
  );
}
