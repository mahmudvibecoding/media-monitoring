"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import { youtubeChannelsOptions } from "@/api/@tanstack/react-query.gen";
import type { YouTubeChannel } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { YouTubeLogo } from "@/components/brand-icons";
import { Pages } from "@/components/pages";
import { SearchBox } from "@/components/search-box";
import { Skeleton } from "@/components/ui/skeleton";
import { ChannelPicture } from "@/components/youtube-ui";
import { go } from "@/lib/address";
import { formatCompact, formatCount, pluralOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { channelsAddress, channelsQuery } from "@/lib/youtube";

const TILE = { width: 160, height: 208, gap: 16 }; // pixels: a tile's least width, its height, the gaps between them
const MOST = 100; // tiles to a page at most, as many as the API gives

// The monitored channels, the biggest first, laid out the way YouTube lays out channels: round pictures in a grid,
// each with its name, handle and subscribers. The grid fills the screen and no more, so the page's buttons (or ← and →)
// are always in view: a page holds as many channels as fit, so its size follows the window's. Searched as one types;
// the address keeps the search and the page. While the next page loads, the last one stays, dimmed.
export function YouTubeChannels() {
  const t = useTranslations("youtubeChannels");
  const locale = useLocale();
  const query = channelsQuery(useSearchParams());
  const area = useRef<HTMLDivElement>(null);
  const fit = useFit(area);
  const size = fit ? Math.min(MOST, fit.columns * fit.rows) : undefined;
  const { data, error, isFetching, isPlaceholderData, refetch } = useQuery({
    ...youtubeChannelsOptions({ query: { ...query, size } }),
    enabled: size !== undefined, // only once the grid is measured
    placeholderData: keepPreviousData,
  });
  const page = query.page ?? 1;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const { search } = query;

  // Past the last page (an old link, a smaller window, or fewer channels since): the last page instead
  const pastTheEnd = !!data && !isPlaceholderData && data.total > 0 && data.channels.length === 0 && page > 1;
  useEffect(() => {
    if (pastTheEnd) go(channelsAddress({ search, page: pages > 1 ? pages : undefined }), "replace");
  }, [pastTheEnd, search, pages]);

  let list;
  if (!data || !fit) {
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <TilesSkeleton />;
  } else if (data.total === 0) {
    list = <p className="text-yt-muted">{search ? t("noMatch", { search }) : t("none")}</p>;
  } else {
    list = (
      <ul
        className={cn("grid gap-4 transition-opacity", isPlaceholderData && "opacity-60")}
        style={{ gridTemplateColumns: `repeat(${fit.columns}, minmax(0, 1fr))` }}
      >
        {data.channels.map((channel) => (
          <ChannelTile key={channel.id} channel={channel} />
        ))}
      </ul>
    );
  }

  return (
    // All the room right of the menu (below the phone's bar), laid over the page's frame like Telegram's chat, so the
    // grid can take the window's whole width and height
    <div className="absolute inset-x-0 top-12 bottom-0 flex flex-col gap-5 px-4 py-5 font-roboto text-yt-text sm:px-8 md:top-0">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <h1>
          <YouTubeLogo className="h-5 w-[93px] text-yt-text" />
          <span className="sr-only">YouTube</span>
        </h1>
        <SearchBox
          look="youtube"
          search={search ?? ""}
          placeholder={t("search")}
          onSearch={(next) => go(channelsAddress({ search: next || undefined }), "replace")}
        />
        {data && (
          <p className="ml-auto text-sm text-yt-muted tabular-nums">
            {search
              ? t("found", { formatted: formatCount(data.total, locale) })
              : t("count", { count: data.total, formatted: formatCount(data.total, locale) })}
          </p>
        )}
      </div>
      <div ref={area} className="min-h-0 flex-1 overflow-hidden">
        {list}
      </div>
      {data && pages > 1 && (
        <Pages
          page={page}
          pages={pages}
          turn={(to) => go(channelsAddress({ search, page: to > 1 ? to : undefined }), "push")}
        />
      )}
    </div>
  );
}

// How many tiles fit the grid's box, across and down, followed as the window changes
function useFit(area: RefObject<HTMLDivElement | null>) {
  const [fit, setFit] = useState<{ columns: number; rows: number } | null>(null);
  useLayoutEffect(() => {
    const box = area.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const columns = Math.max(1, Math.floor((width + TILE.gap) / (TILE.width + TILE.gap)));
      const rows = Math.max(1, Math.floor((height + TILE.gap) / (TILE.height + TILE.gap)));
      setFit((last) => (last?.columns === columns && last.rows === rows ? last : { columns, rows }));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [area]);
  return fit;
}

// A channel as YouTube shows one among others: its picture, name, handle and subscribers, centered, in a tile of fixed
// height (the name in up to two lines), so the grid knows how many fit. The whole tile opens the channel's page here
// (not fetched ahead: a page of tiles would mean as many requests).
function ChannelTile({ channel }: { channel: YouTubeChannel }) {
  const t = useTranslations("youtubeChannels");
  const channelTexts = useTranslations("youtubeChannel");
  const locale = useLocale();
  const name = channel.title?.trim() || channel.id; // the ID until the channel's details are fetched
  return (
    <li
      className="relative flex flex-col items-center overflow-hidden rounded-xl px-2 pt-3 text-center hover:bg-yt-chip"
      style={{ height: TILE.height }}
    >
      <ChannelPicture url={channel.avatar_url} size={96} />
      <Link
        href={`/youtube/channels/${channel.id}`}
        prefetch={false}
        className={cn(
          "mt-3 line-clamp-2 text-[15px] leading-5 font-medium after:absolute after:inset-0",
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

// The grid's shape while its first channels load (or before it's measured)
function TilesSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: 12 }, (_, tile) => (
        <div key={tile} className="flex flex-col items-center gap-3 pt-3" style={{ height: TILE.height }}>
          <Skeleton className="size-24 rounded-full" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}
