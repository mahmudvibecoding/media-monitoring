"use client";

import { type InfiniteData, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import type { TelegramChannels } from "@/api/types.gen";
import { ChannelPhoto } from "@/components/telegram-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCompact, pluralOf } from "@/lib/format";

// A chat's shape while it loads: its top bar, already with the channel's picture, name and subscribers when the chat
// list has them (the chat opens at once, as in Telegram), and bubbles' shapes at the bottom
export function ChatGhost() {
  const t = useTranslations("telegramChannel");
  const common = useTranslations("common");
  const locale = useLocale();
  const id = Number(useParams<{ id: string }>().id);
  const client = useQueryClient();
  // Read from the list's pages already in the browser, without asking for anything
  const channel = client
    .getQueriesData<InfiniteData<TelegramChannels>>({ queryKey: [{ _id: "telegramChannels", _infinite: true }] })
    .flatMap(([, data]) => data?.pages ?? [])
    .flatMap((page) => page.channels)
    .find((listed) => listed.id === id);
  const name = channel ? channel.title?.trim() || `@${channel.username}` : "";
  return (
    <div className="absolute inset-0" aria-busy="true">
      <span className="sr-only">{common("loading")}</span>
      <div className="absolute inset-x-4 top-4 z-20 mx-auto flex h-12 max-w-[728px] items-center rounded-[2rem] bg-white p-1 shadow-tg-pane max-[600px]:inset-x-2 max-[600px]:top-2">
        {channel ? (
          <>
            <ChannelPhoto id={channel.id} name={name} url={channel.photo_url} size={40} className="mr-2.5" />
            <span className="min-w-0">
              <span className="block truncate text-[17px] leading-6 [font-weight:var(--tg-semibold)]">{name}</span>
              <span className="block truncate text-sm leading-[18px] text-tg-muted">
                {channel.subscribers === null
                  ? `@${channel.username}`
                  : t("subscribers", {
                      count: pluralOf(channel.subscribers),
                      formatted: formatCompact(channel.subscribers, locale),
                    })}
              </span>
            </span>
          </>
        ) : (
          <>
            <Skeleton className="mr-2.5 size-10 rounded-full" />
            <span className="space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </span>
          </>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 mx-auto flex max-w-[760px] flex-col px-4 pb-4 max-[600px]:px-2">
        <BubblesGhost />
      </div>
    </div>
  );
}

// Bubbles' shapes, while messages load
export function BubblesGhost({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col items-start gap-2.5">
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="w-[min(29rem,calc(100%-3rem))] animate-pulse rounded-[15px] rounded-bl-none bg-white/70"
          style={{ height: [72, 112, 56, 96][row % 4] }}
        />
      ))}
    </div>
  );
}
