"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon, SearchIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { youtubeChannelsOptions } from "@/api/@tanstack/react-query.gen";
import type { YouTubeChannel } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { channelsAddress, type ChannelsQuery, channelsQuery, SEARCH_MAX } from "@/lib/youtube-channels";

const SEARCH_WAIT = 300; // milliseconds after the last key before the list is searched
const AVATAR_SIZE = 88; // pixels: twice what the list shows, for sharp screens

// A new address for the list, without asking the server: Next follows it (useSearchParams), and the list loads what it
// asks for. A new page or order is a step that Back undoes; each key typed into the search isn't.
function go(query: ChannelsQuery, step: "push" | "replace") {
  const address = channelsAddress(query) || window.location.pathname;
  if (step === "push") window.history.pushState(null, "", address);
  else window.history.replaceState(null, "", address);
}

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
    if (pastTheEnd) go({ search, sort, page: pages > 1 ? pages : undefined }, "replace");
  }, [pastTheEnd, search, sort, pages]);

  function turn(to: number) {
    go({ search, sort, page: to > 1 ? to : undefined }, "push");
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
          onValueChange={(value) => go({ search, sort: value === "name" ? "name" : undefined }, "push")}
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
      go({ search: next || undefined, sort: query.sort }, "replace");
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
      {/* The name takes the room the other columns leave, and a name too long for it is cut short (…) */}
      <TableCell className="w-full max-w-0 pl-4">
        <a
          href={`https://www.youtube.com/channel/${channel.id}`}
          target="_blank"
          rel="noreferrer"
          title={t("open")}
          className="flex min-w-0 items-center gap-3 hover:underline"
        >
          <Avatar>
            {channel.avatar_url && (
              // YouTube's pictures are saved at 900 × 900 (114 KB); its image server makes any size the address names
              <AvatarImage
                src={channel.avatar_url.replace(/=s\d+(?=-|$)/, `=s${AVATAR_SIZE}`)}
                alt=""
                referrerPolicy="no-referrer"
              />
            )}
            <AvatarFallback>{Array.from(name)[0]?.toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="min-w-0">
            <span className={cn("block truncate font-medium", !channel.title && "font-mono text-muted-foreground")}>
              {name}
            </span>
            {channel.handle && <span className="block truncate text-muted-foreground sm:hidden">{channel.handle}</span>}
          </span>
        </a>
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

// Which page of how many, and buttons to the first, the one before, the next and the last
function Pages({ page, pages, turn }: { page: number; pages: number; turn: (to: number) => void }) {
  const t = useTranslations("youtubeChannels");
  const locale = useLocale();
  const buttons = [
    { to: 1, label: t("first"), icon: ChevronsLeftIcon, off: page <= 1 },
    { to: page - 1, label: t("previous"), icon: ChevronLeftIcon, off: page <= 1 },
    { to: page + 1, label: t("next"), icon: ChevronRightIcon, off: page >= pages },
    { to: pages, label: t("last"), icon: ChevronsRightIcon, off: page >= pages },
  ];
  return (
    <div className="flex items-center justify-between gap-4">
      <p className="text-sm text-muted-foreground tabular-nums">
        {t("page", { page: formatCount(page, locale), pages: formatCount(pages, locale) })}
      </p>
      <div className="flex gap-1">
        {buttons.map(({ to, label, icon: Icon, off }) => (
          <Button
            key={label}
            variant="outline"
            size="icon-sm"
            aria-label={label}
            disabled={off}
            onClick={() => turn(to)}
          >
            <Icon />
          </Button>
        ))}
      </div>
    </div>
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
