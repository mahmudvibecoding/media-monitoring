"use client";

import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheckIcon, ListChecksIcon, SearchIcon, XIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { labelledProgressOptions, telegramChannelsInfiniteOptions } from "@/api/@tanstack/react-query.gen";
import type { TelegramChannel } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { PageLink } from "@/components/page-link";
import { ChannelPhoto, oneLine, Ripples, RoundButton } from "@/components/telegram-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { useSidebar } from "@/components/ui/sidebar";
import { SEARCH_MAX, searchOf } from "@/lib/address";
import { formatChatDate, formatCompact, formatCount, formatDateTime, pluralOf } from "@/lib/format";
import { DIMMED, FIRST_PAGE, nextPage } from "@/lib/pages";
import { channelsQuery, chatIdOf, chatPath, type Labeller, labellerOf, type TelegramFolder } from "@/lib/telegram";
import { useLoadMore } from "@/lib/use-load-more";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const FOLDERS = ["subscribers", "latest", "labelled"] as const satisfies readonly TelegramFolder[];

// Telegram's chat list, in its floating panel at the left: Telegram's ☰ (which opens the site's menu) and search field
// at the top, then the monitored channels as Telegram lists chats, more loading as they're scrolled. Three folders in
// Telegram's floating tabs: the biggest first, the latest to post first, and the channels with names labelled by hand
// (the biggest first), whose chats open on the messages with them alone, with the names of whoever the chat open shows
// (by hand, or a model). Focusing the search turns ☰ into ← and the folders away, as in Telegram; the list is searched
// at each key, the last results staying until the new ones come. The chat open beside is the blue row. The list is the
// layout's, so it stays as chats open and close, scrolled where it was.
export function TelegramList() {
  const t = useTranslations("telegramChannels");
  const nav = useTranslations("nav");
  const locale = useLocale();
  const openId = chatIdOf(usePathname());
  const labeller = labellerOf(useSearchParams().get("labelled")) ?? "hand";
  // The row clicked last, and the chat open then: it's the blue row at once, as in Telegram, until its chat opens
  const [clicked, setClicked] = useState<{ id: number; on: number | null } | null>(null);
  const shownId = clicked?.on === openId ? clicked.id : openId;
  const { toggleSidebar } = useSidebar();
  const [folder, setFolder] = useState<TelegramFolder>("subscribers");
  const [searching, setSearching] = useState(false);
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const search = searching ? searchOf(new URLSearchParams({ search: typed })) : "";
  const { data, error, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch, isPlaceholderData } =
    useInfiniteQuery({
      ...telegramChannelsInfiniteOptions({ query: channelsQuery(folder, search) }),
      ...FIRST_PAGE,
      getNextPageParam: nextPage("channels"),
      placeholderData: keepPreviousData,
    });
  const marker = useLoadMore({ more: !!hasNextPage, loading: isFetchingNextPage, load: fetchNextPage, root: scroller });

  // The other folders' chats, asked for once the list is there, and a folder's once the pointer comes over it, so that
  // it shows them at once
  const queryClient = useQueryClient();
  const ahead = (other: TelegramFolder) =>
    void queryClient.prefetchInfiniteQuery({
      ...telegramChannelsInfiniteOptions({ query: channelsQuery(other, "") }),
      ...FIRST_PAGE,
    });
  const ready = !!data;
  useEffect(() => {
    if (!ready) return;
    for (const other of FOLDERS) {
      if (other === folder) continue;
      void queryClient.prefetchInfiniteQuery({
        ...telegramChannelsInfiniteOptions({ query: channelsQuery(other, "") }),
        ...FIRST_PAGE,
      });
    }
  }, [ready, folder, queryClient]);

  // Another folder or search shows its list from the top
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [folder, search]);

  function leave() {
    setSearching(false);
    setTyped("");
    input.current?.blur();
  }

  const channels = data?.pages.flatMap((page) => page.channels) ?? [];
  const total = data?.pages[0]?.total ?? 0;
  let content;
  if (!data) {
    content = error ? (
      <div className="px-2 py-6">
        <ApiError error={error} retry={() => void refetch()} retrying={isFetching} />
      </div>
    ) : (
      <ChatsSkeleton />
    );
  } else if (total === 0) {
    content = search ? (
      <div className="px-6 pt-10 text-center">
        <p className="text-xl leading-7 font-medium">{t("noResults")}</p>
        <p className="mt-1 text-sm text-tg-muted">{t("noResultsFor", { search })}</p>
      </div>
    ) : (
      <p className="px-6 pt-10 text-center text-tg-muted">{t("none")}</p>
    );
  } else {
    content = (
      <>
        {search && (
          <h3 className="px-3 pt-1 pb-2 text-[15px] leading-5 font-medium text-tg-muted">
            {t("found", { formatted: formatCount(total, locale) })}
          </h3>
        )}
        {folder === "labelled" && !search && <Progress />}
        <ul className={cn("transition-opacity", isPlaceholderData && DIMMED)}>
          {channels.map((channel) => (
            <ChatRow
              key={channel.id}
              channel={channel}
              open={channel.id === shownId}
              current={channel.id === openId}
              onOpen={() => setClicked({ id: channel.id, on: openId })}
              searched={!!search}
              labelled={folder === "labelled" && !search ? labeller : null}
            />
          ))}
        </ul>
        <div ref={marker} />
        {isFetchingNextPage && <ChatsSkeleton rows={2} />}
      </>
    );
  }

  return (
    <>
      <div className="flex h-16 shrink-0 items-center px-[13px] py-2">
        {/* Telegram's ☰ opens the site's menu on a phone; on a wide screen the menu is always there, so only the ←
            of a search shows, coming in beside the field */}
        <div
          className={cn(
            "w-[3.125rem] shrink-0 overflow-hidden transition-[width] duration-200",
            !searching && "md:invisible md:w-0",
          )}
        >
          <RoundButton label={searching ? t("back") : nav("toggle")} onClick={searching ? leave : toggleSidebar}>
            <span className="tg-menu-icon" data-back={searching ? "" : undefined} />
          </RoundButton>
        </div>
        <label className="group flex h-11 min-w-0 flex-1 items-center rounded-[22px] border-2 border-tg-hover bg-tg-hover pr-[3px] text-[rgb(112_117_121/0.5)] transition-colors duration-150 focus-within:border-tg-blue focus-within:bg-white">
          <SearchIcon className="ml-3 size-6 shrink-0 group-focus-within:text-tg-blue" strokeWidth={1.75} />
          <input
            ref={input}
            type="search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onFocus={() => setSearching(true)}
            onKeyDown={(event) => event.key === "Escape" && leave()}
            placeholder={t("search")}
            maxLength={SEARCH_MAX}
            enterKeyHint="search"
            aria-label={t("search")}
            className="h-10 min-w-0 flex-1 bg-transparent pt-[5px] pr-2 pb-1.5 pl-2.5 text-base leading-5 text-black caret-tg-blue outline-none placeholder:text-tg-placeholder [&::-webkit-search-cancel-button]:hidden"
          />
          {typed && (
            <RoundButton
              label={t("clear")}
              onClick={() => {
                setTyped("");
                input.current?.focus();
              }}
              className="text-tg-muted"
            >
              <XIcon className="size-5" />
            </RoundButton>
          )}
        </label>
      </div>
      <div className="relative min-h-0 flex-1">
        {!searching && (
          <>
            <Folders folder={folder} choose={setFolder} ahead={ahead} />
            <div className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-[70px] bg-linear-to-b from-white from-40% to-transparent" />
          </>
        )}
        <div
          ref={scroller}
          className={cn(
            "h-full [scrollbar-width:thin] [scrollbar-color:transparent_transparent] overflow-y-auto overscroll-contain px-2 pb-2 hover:[scrollbar-color:rgb(90_90_90/0.3)_transparent]",
            searching ? "pt-1" : "pt-14",
          )}
        >
          {content}
        </div>
      </div>
    </>
  );
}

// Telegram's folders: tabs on a floating white bar, the chosen one blue on light blue. The blue copy of the tabs lies
// over the grey ones, cut to the chosen tab's shape (clip-path), so that as another is chosen, the cut slides there and
// each letter turns blue as it passes under it, as in Telegram.
function Folders({
  folder,
  choose,
  ahead,
}: {
  folder: TelegramFolder;
  choose: (folder: TelegramFolder) => void;
  ahead: (folder: TelegramFolder) => void;
}) {
  const t = useTranslations("telegramChannels");
  const locale = useLocale(); // the tabs' widths change with their words
  const bar = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const element = bar.current;
    const blue = copy.current;
    if (!element || !blue) return;
    function place() {
      const tab = element?.querySelector<HTMLElement>(`[data-folder="${folder}"]`);
      if (!element || !blue || !tab) return;
      const right = element.scrollWidth - tab.offsetLeft - tab.offsetWidth;
      blue.style.clipPath = `inset(6px ${right}px 6px ${tab.offsetLeft}px round 20px)`;
    }
    if (!placed.current) {
      // Where it starts, without sliding there
      blue.style.transition = "none";
      place();
      void blue.offsetWidth;
      blue.style.transition = "";
      placed.current = true;
    } else {
      place();
    }
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [folder, locale]);
  const labels = { subscribers: t("biggest"), latest: t("latest"), labelled: t("labelled") };
  const tab = "shrink-0 rounded-[20px] px-4 py-1.5 text-base leading-6 font-medium whitespace-nowrap";
  return (
    <div className="absolute inset-x-2 top-1 z-10">
      <div
        ref={bar}
        role="tablist"
        aria-label={t("folders")}
        className="relative flex [scrollbar-width:none] overflow-x-auto rounded-[1.5rem] bg-white px-1 py-1.5 text-tg-muted shadow-[0_1px_8px_0_rgb(0_0_0/0.1)]"
      >
        {FOLDERS.map((each) => (
          <button
            key={each}
            type="button"
            role="tab"
            aria-selected={folder === each}
            data-folder={each}
            onClick={() => choose(each)}
            onPointerEnter={() => ahead(each)}
            onFocus={() => ahead(each)}
            className={cn(tab, "hover:opacity-85")}
          >
            {labels[each]}
          </button>
        ))}
        <div
          ref={copy}
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 flex min-w-full bg-white bg-[linear-gradient(var(--color-tg-tab),var(--color-tg-tab))] px-1 py-1.5 text-tg-blue transition-[clip-path] duration-300 ease-tg-slide [clip-path:inset(50%)]"
        >
          {FOLDERS.map((each) => (
            <span key={each} className={tab}>
              {labels[each]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// A channel as Telegram lists a chat: its picture, its name with when it last posted at the right (the time today,
// the weekday this week, the day before), and its latest message on one line below; in a search's results, its
// @username and subscribers instead, as Telegram's search shows a channel. The whole row opens the channel's chat (in
// the labelled folder, with its labelled messages alone), which is fetched ahead once the pointer comes over it (not
// for every row in view: that's dozens of requests); it's the blue row (open) from the click, before its chat is there
// (current).
function ChatRow({
  channel,
  open,
  current,
  onOpen,
  searched,
  labelled,
}: {
  channel: TelegramChannel;
  open: boolean;
  current: boolean;
  onOpen: () => void;
  searched: boolean;
  labelled: Labeller | null;
}) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  const now = useNow();
  const router = useRouter();
  const name = channel.title?.trim() || `@${channel.username}`;
  const href = chatPath(channel.id, labelled);
  let line = channel.last_message ? oneLine(channel.last_message) : "";
  if (searched) {
    line = `@${channel.username}`;
    if (channel.subscribers !== null) {
      line += `, ${t("subscribers", {
        count: pluralOf(channel.subscribers),
        formatted: formatCompact(channel.subscribers, locale),
      })}`;
    }
  }
  return (
    <li className="[contain-intrinsic-size:auto_72px] [content-visibility:auto]">
      <PageLink
        href={href}
        line="telegram"
        prefetch={false}
        onPointerEnter={() => router.prefetch(href)}
        onFocus={() => router.prefetch(href)}
        onClick={onOpen}
        aria-current={current ? "page" : undefined}
        className={cn(
          "relative flex h-[72px] items-center gap-2 tg-item p-[9px]",
          open ? "bg-tg-blue text-white" : "hover:bg-tg-hover",
        )}
      >
        <ChannelPhoto id={channel.id} name={name} url={channel.photo_url} size={54} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate leading-6 [font-weight:var(--tg-semibold)]">{name}</span>
            {channel.last_message_at && (
              <time
                dateTime={channel.last_message_at}
                title={formatDateTime(channel.last_message_at, locale)}
                className={cn("shrink-0 text-xs leading-[18px]", open ? "text-white" : "text-(color:--tg-list-meta)")}
              >
                {formatChatDate(channel.last_message_at, now, locale)}
              </time>
            )}
          </span>
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "block min-w-0 flex-1 truncate text-(length:--tg-list-line) leading-6",
                open ? "text-white" : "text-(color:--tg-list-muted)",
              )}
              title={searched && channel.subscribers !== null ? formatCount(channel.subscribers, locale) : undefined}
            >
              {line}
            </span>
            {/* In the labelled folder: its messages still to check, as Telegram counts a chat's unread ones; ✓✓ when
                all are checked */}
            {channel.unchecked != null &&
              (channel.unchecked > 0 ? (
                <span
                  title={t("toCheck", { count: channel.unchecked })}
                  className={cn(
                    "min-w-[22px] shrink-0 rounded-full px-1.5 text-center text-sm leading-[22px] font-medium",
                    open ? "bg-white text-tg-blue" : "bg-tg-blue text-white",
                  )}
                >
                  {channel.unchecked}
                </span>
              ) : (
                <CheckCheckIcon
                  aria-label={t("allCheckedHere")}
                  className={cn("size-5 shrink-0", open ? "text-white" : "text-tg-checked")}
                />
              ))}
          </span>
        </span>
        <Ripples />
      </PageLink>
    </li>
  );
}

// Above the labelled folder's channels, as Telegram's row of archived chats: how many of the messages labelled by hand
// are checked, and the way on to the first channel with one still to check, in the folder's order
function Progress() {
  const t = useTranslations("telegramChannels");
  const locale = useLocale();
  const { data } = useQuery(labelledProgressOptions());
  if (!data) return null;
  const counts = { checked: formatCount(data.checked, locale), total: formatCount(data.messages, locale) };
  const row = "relative flex h-14 items-center gap-3 tg-item px-[9px]";
  const content = (
    <>
      <span className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-tg-checked text-white">
        <ListChecksIcon className="size-6" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate leading-6 [font-weight:var(--tg-semibold)]">{t("checked", counts)}</span>
        <span className="block truncate text-sm leading-5 text-tg-blue">
          {data.next ? t("continue") : t("allChecked")}
        </span>
      </span>
    </>
  );
  return data.next ? (
    <PageLink href={chatPath(data.next, "hand")} line="telegram" className={cn(row, "mb-1 hover:bg-tg-hover")}>
      {content}
      <Ripples />
    </PageLink>
  ) : (
    <div className={cn(row, "mb-1")}>{content}</div>
  );
}

// The list's shape while its channels load
function ChatsSkeleton({ rows = 10 }: { rows?: number }) {
  const t = useTranslations("common");
  return (
    <div aria-busy="true">
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex h-[72px] items-center gap-2 p-[9px]">
          <Skeleton className="size-[54px] rounded-full" />
          <div className="flex-1 space-y-2.5">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
