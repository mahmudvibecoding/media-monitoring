"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";

import { telegramChannelsOptions } from "@/api/@tanstack/react-query.gen";
import type { TelegramChannel } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { Pages } from "@/components/pages";
import { SearchBox } from "@/components/search-box";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { go } from "@/lib/address";
import { formatCount, formatDateTime, initialOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { channelOnTelegram, telegramChannelsAddress, telegramChannelsQuery } from "@/lib/telegram";

const ORDERS = ["subscribers", "name", "latest"] as const;

// The monitored Telegram channels, as the address asks for them, a page at a time: searched as one types, the biggest
// first, by name, or the latest to post first. While the next list loads, the last one stays, dimmed.
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

  const labels = { subscribers: t("biggest"), name: t("byName"), latest: t("latest") };
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
                <TableHead className="hidden sm:table-cell">{t("username")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("latestPost")}</TableHead>
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
        <SearchBox
          search={search ?? ""}
          placeholder={t("search")}
          onSearch={(next) => go(telegramChannelsAddress({ search: next || undefined, sort }), "replace")}
        />
        <Select
          items={ORDERS.map((order) => ({ value: order, label: labels[order] }))}
          value={sort ?? "subscribers"}
          onValueChange={(value) =>
            go(
              telegramChannelsAddress({ search, sort: value === "name" || value === "latest" ? value : undefined }),
              "push",
            )
          }
        >
          <SelectTrigger aria-label={t("order")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ORDERS.map((order) => (
              <SelectItem key={order} value={order}>
                {labels[order]}
              </SelectItem>
            ))}
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

function ChannelRow({ channel }: { channel: TelegramChannel }) {
  const t = useTranslations("telegramChannels");
  const locale = useLocale();
  const name = channel.title?.trim() || `@${channel.username}`;
  return (
    <TableRow>
      {/* The name takes the room the other columns leave, and a name too long for it is cut short (…). It opens the
          channel's page here (not fetched ahead: 50 rows would mean 50 requests), and the icon after it, Telegram's. */}
      <TableCell className="w-full max-w-0 pl-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href={`/telegram/channels/${channel.id}`}
            prefetch={false}
            className="flex min-w-0 items-center gap-3 hover:underline"
          >
            <Avatar>
              {channel.photo_url && <AvatarImage src={channel.photo_url} alt="" referrerPolicy="no-referrer" />}
              <AvatarFallback>{initialOf(name)}</AvatarFallback>
            </Avatar>
            <span className="min-w-0">
              <span className="block truncate font-medium">{name}</span>
              <span className="block truncate text-muted-foreground sm:hidden">@{channel.username}</span>
            </span>
          </Link>
          <a
            href={channelOnTelegram(channel.username)}
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
      <TableCell className="hidden text-muted-foreground sm:table-cell">@{channel.username}</TableCell>
      <TableCell className="hidden text-muted-foreground tabular-nums lg:table-cell">
        {channel.last_message_at ? formatDateTime(channel.last_message_at, locale) : "—"}
      </TableCell>
      <TableCell className="pr-4 text-right tabular-nums">
        {channel.subscribers === null ? "—" : formatCount(channel.subscribers, locale)}
      </TableCell>
    </TableRow>
  );
}
