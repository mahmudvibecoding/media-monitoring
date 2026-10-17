"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { youtubeChannelsOptions } from "@/api/@tanstack/react-query.gen";
import type { YouTubeChannel } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { Pages } from "@/components/pages";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { go } from "@/lib/address";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  avatarAt,
  channelOnYouTube,
  channelsAddress,
  type ChannelsQuery,
  channelsQuery,
  SEARCH_MAX,
} from "@/lib/youtube";

const SEARCH_WAIT = 300; // milliseconds after the last key before the list is searched
const AVATAR_SIZE = 88; // pixels: twice what the list shows, for sharp screens

// The monitored channels, as the address asks for them, a page at a time: searched as one types, the biggest first or
// by name. While the next list loads, the last one stays, dimmed.
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
    list = error ? <ApiError error={error} retry={() => void refetch()} retrying={isFetching} /> : <ListSkeleton />;
  } else if (data.total === 0) {
    list = <p className="text-muted-foreground">{search ? t("noMatch", { search }) : t("none")}</p>;
  } else {
    list = (
      <>
        <div className={cn("rounded-xl border transition-opacity", isPlaceholderData && "opacity-60")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t("channel")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("handle")}</TableHead>
                <TableHead className="pr-4 text-right">{t("subscribers")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.channels.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} />
              ))}
            </TableBody>
          </Table>
        </div>
        {pages > 1 && <Pages page={page} pages={pages} turn={turn} />}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox query={query} />
        <Select
          items={[
            { value: "subscribers", label: t("biggest") },
            { value: "name", label: t("byName") },
          ]}
          value={sort ?? "subscribers"}
          onValueChange={(value) =>
            go(channelsAddress({ search, sort: value === "name" ? "name" : undefined }), "push")
          }
        >
          <SelectTrigger aria-label={t("order")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="subscribers">{t("biggest")}</SelectItem>
            <SelectItem value="name">{t("byName")}</SelectItem>
          </SelectContent>
        </Select>
        {data && (
          <p className="ml-auto text-sm text-muted-foreground tabular-nums">
            {search
              ? t("found", { formatted: formatCount(data.total, locale) })
              : t("count", { count: data.total, formatted: formatCount(data.total, locale) })}
          </p>
        )}
      </div>
      {list}
    </div>
  );
}

// The search box: the list is searched a moment after the last key, and the address keeps the search, so that Back
// and a copied link bring it back. When the address changes some other way (Back, Forward, the menu), the box follows.
function SearchBox({ query }: { query: ChannelsQuery }) {
  const t = useTranslations("youtubeChannels");
  const search = query.search ?? "";
  const [text, setText] = useState(search);
  const [written, setWritten] = useState(search); // the search this box last put in the address
  if (search !== written) {
    setWritten(search);
    setText(search);
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function type(value: string) {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = channelsQuery(new URLSearchParams({ search: value })).search ?? "";
      if (next === written) return; // only spaces changed
      setWritten(next);
      go(channelsAddress({ search: next || undefined, sort: query.sort }), "replace");
    }, SEARCH_WAIT);
  }

  return (
    <div className="relative w-full sm:w-80">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={text}
        onChange={(event) => type(event.target.value)}
        placeholder={t("search")}
        aria-label={t("search")}
        maxLength={SEARCH_MAX}
        className="pl-8"
      />
    </div>
  );
}

function ChannelRow({ channel }: { channel: YouTubeChannel }) {
  const t = useTranslations("youtubeChannels");
  const locale = useLocale();
  const name = channel.title?.trim() || channel.id; // the ID until the channel's details are fetched
  return (
    <TableRow>
      {/* The name takes the room the other columns leave, and a name too long for it is cut short (…). It opens the
          channel's page here (not fetched ahead: 50 rows would mean 50 requests), and the icon after it, YouTube's. */}
      <TableCell className="w-full max-w-0 pl-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/youtube/channels/${channel.id}`}
            prefetch={false}
            className="flex min-w-0 items-center gap-3 hover:underline"
          >
            <Avatar>
              {channel.avatar_url && (
                <AvatarImage src={avatarAt(channel.avatar_url, AVATAR_SIZE)} alt="" referrerPolicy="no-referrer" />
              )}
              <AvatarFallback>{Array.from(name)[0]?.toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <span className={cn("block truncate font-medium", !channel.title && "font-mono text-muted-foreground")}>
                {name}
              </span>
              {channel.handle && (
                <span className="block truncate text-muted-foreground sm:hidden">{channel.handle}</span>
              )}
            </span>
          </Link>
          <a
            href={channelOnYouTube(channel.id)}
            target="_blank"
            rel="noreferrer"
            title={t("open")}
            aria-label={t("open")}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </div>
      </TableCell>
      <TableCell className="hidden text-muted-foreground sm:table-cell">{channel.handle}</TableCell>
      <TableCell className="pr-4 text-right tabular-nums">
        {channel.subscribers === null ? (
          <span className="text-muted-foreground">{t("hidden")}</span>
        ) : (
          formatCount(channel.subscribers, locale)
        )}
      </TableCell>
    </TableRow>
  );
}

// The list's shape while its first channels load
function ListSkeleton() {
  const t = useTranslations("common");
  return (
    <div className="space-y-2 rounded-xl border p-4" aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: 10 }, (_, row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-full" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
