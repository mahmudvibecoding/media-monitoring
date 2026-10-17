"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";

import { youtubeChannelsOptions } from "@/api/@tanstack/react-query.gen";
import type { YouTubeChannel } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { Pages } from "@/components/pages";
import { SearchBox } from "@/components/search-box";
import { Skeleton } from "@/components/ui/skeleton";
import { ChannelPicture, Chips } from "@/components/youtube-ui";
import { go } from "@/lib/address";
import { formatCompact, formatCount, pluralOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { channelsAddress, channelsQuery } from "@/lib/youtube";

// The monitored channels, as the address asks for them, a page at a time, laid out the way YouTube lays out channels:
// round pictures in a grid, each with its name, handle and subscribers. Searched as one types, the biggest first or by
// name (YouTube's chips). While the next page loads, the last one stays, dimmed.
export function YouTubeChannels() {
  const t = useTranslations("youtubeChannels");
  const locale = useLocale();
  const query = channelsQuery(useSearchParams());
  const { data, error, isFetching, isPlaceholderData, refetch } = useQuery({
    ...youtubeChannelsOptions({ query }),
    placeholderData: keepPreviousData,
  });
  const page = query.page ?? 1;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const { search, sort } = query;

  // Past the last page (an old link, or fewer channels since): the last page instead
  const pastTheEnd = !!data && !isPlaceholderData && data.total > 0 && data.channels.length === 0 && page > 1;
  useEffect(() => {
    if (pastTheEnd) go(channelsAddress({ search, sort, page: pages > 1 ? pages : undefined }), "replace");
  }, [pastTheEnd, search, sort, pages]);

  function turn(to: number) {
    go(channelsAddress({ search, sort, page: to > 1 ? to : undefined }), "push");
    window.scrollTo({ top: 0 });
  }

  let list;
  if (!data) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <TilesSkeleton />;
  } else if (data.total === 0) {
    list = <p className="text-yt-muted">{search ? t("noMatch", { search }) : t("none")}</p>;
  } else {
    list = (
      <>
        <ul
          className={cn(
            "grid grid-cols-2 gap-x-4 gap-y-6 transition-opacity sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6",
            isPlaceholderData && "opacity-60",
          )}
        >
          {data.channels.map((channel) => (
            <ChannelTile key={channel.id} channel={channel} />
          ))}
        </ul>
        {pages > 1 && <Pages page={page} pages={pages} turn={turn} />}
      </>
    );
  }

  return (
    <div className="space-y-6 font-roboto text-yt-text">
      <div className="flex flex-wrap items-center gap-4">
        <SearchBox
          look="youtube"
          search={search ?? ""}
          placeholder={t("search")}
          onSearch={(next) => go(channelsAddress({ search: next || undefined, sort }), "replace")}
        />
        {data && (
          <p className="ml-auto text-sm text-yt-muted tabular-nums">
            {search
              ? t("found", { formatted: formatCount(data.total, locale) })
              : t("count", { count: data.total, formatted: formatCount(data.total, locale) })}
          </p>
        )}
      </div>
      <Chips
        label={t("order")}
        options={[
          { value: "subscribers", label: t("biggest") },
          { value: "name", label: t("byName") },
        ]}
        value={sort ?? "subscribers"}
        onChange={(value) => go(channelsAddress({ search, sort: value === "name" ? "name" : undefined }), "push")}
      />
      {list}
    </div>
  );
}

// A channel as YouTube shows one among others: its picture, name, handle and subscribers, centered. The whole tile
// opens the channel's page here (not fetched ahead: 50 tiles would mean 50 requests).
function ChannelTile({ channel }: { channel: YouTubeChannel }) {
  const t = useTranslations("youtubeChannels");
  const channelTexts = useTranslations("youtubeChannel");
  const locale = useLocale();
  const name = channel.title?.trim() || channel.id; // the ID until the channel's details are fetched
  return (
    <li className="group relative flex flex-col items-center rounded-xl px-2 py-4 text-center hover:bg-yt-chip">
      <ChannelPicture url={channel.avatar_url} size={104} />
      <Link
        href={`/youtube/channels/${channel.id}`}
        prefetch={false}
        className={cn(
          "mt-3 line-clamp-2 text-base leading-snug font-medium after:absolute after:inset-0",
          channel.title ? "break-words" : "font-mono text-xs break-all text-yt-muted",
        )}
      >
        {name}
      </Link>
      {channel.handle && <p className="mt-1 w-full truncate text-xs text-yt-muted">{channel.handle}</p>}
      <p
        className="text-xs text-yt-muted"
        title={channel.subscribers === null ? undefined : formatCount(channel.subscribers, locale)}
      >
        {channel.subscribers === null
          ? t("hidden")
          : channelTexts("subscribers", {
              count: pluralOf(channel.subscribers),
              formatted: formatCompact(channel.subscribers, locale),
            })}
      </p>
    </li>
  );
}

// The grid's shape while its first channels load
function TilesSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: 12 }, (_, tile) => (
        <div key={tile} className="flex flex-col items-center gap-3 py-4">
          <Skeleton className="size-26 rounded-full" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}
