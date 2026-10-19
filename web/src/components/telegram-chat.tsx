"use client";

import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ClockIcon,
  InfoIcon,
  LinkIcon,
  MessageSquareTextIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";

import { telegramChannelMessagesInfiniteOptions, telegramChannelOptions } from "@/api/@tanstack/react-query.gen";
import type { TelegramChannelDetails, TelegramMessage } from "@/api/types.gen";
import { ApiError } from "@/components/api-error";
import { PageLink, PageLoadingLine, useGo } from "@/components/page-link";
import { useTelegram } from "@/components/telegram-frame";
import { BubblesGhost, ChatGhost } from "@/components/telegram-ghosts";
import { ChannelPhoto, InfoRow, Ripples, RoundButton, ShareIcon, TelegramText } from "@/components/telegram-ui";
import { SEARCH_MAX, searchOf } from "@/lib/address";
import { formatClock, formatCompact, formatCount, formatDateTime, formatDay, pluralOf, sameDay } from "@/lib/format";
import { DIMMED, FIRST_PAGE, nextPage } from "@/lib/pages";
import { messageOnTelegram } from "@/lib/telegram";
import { useLoadMore } from "@/lib/use-load-more";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const GROUP_WITHIN = 10 * 60 * 1000; // ms: a message this soon after the one before joins its group, as in Telegram
const DOWN_FROM = 200; // px above the newest messages: higher up, the button back to them shows
const SEARCH_WAIT = 300; // ms after the last key before the chat is searched
const SCROLLING_FOR = 1000; // ms after scrolling stops while the date stuck at the top still shows

// A channel's chat, as Telegram Web shows one: its top bar floating over the chat (the picture, the name and the
// subscribers, which open the channel's info; the search), and its saved messages as Telegram's bubbles on Telegram's
// wallpaper, the newest at the bottom, each day under its date. As in Telegram, Ctrl+F (⌘F) opens the search, and Esc
// closes the search, then the info, then the chat.
export function TelegramChat({ id }: { id: number }) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  const [go, going] = useGo();
  const { info, setInfo } = useTelegram();
  const [searching, setSearching] = useState(false);
  const [typed, setTyped] = useState("");
  const [asked, setAsked] = useState(""); // the search the chat shows, a moment after the last key
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const field = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const { data, error, isFetching, refetch } = useQuery(telegramChannelOptions({ path: { channel_id: id } }));

  function type(value: string) {
    setTyped(value);
    clearTimeout(timer.current);
    const next = searchOf(new URLSearchParams({ search: value }));
    timer.current = setTimeout(() => setAsked(next), SEARCH_WAIT);
  }

  function find(text: string) {
    setSearching(true);
    clearTimeout(timer.current);
    setTyped(text);
    setAsked(text);
  }

  function stopSearching() {
    clearTimeout(timer.current);
    setSearching(false);
    setTyped("");
    setAsked("");
  }

  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        if (searching) field.current?.focus();
        else setSearching(true);
        return;
      }
      const target = event.target as HTMLElement;
      if (event.key !== "Escape" || target.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (searching) stopSearching();
      else if (info) setInfo(false);
      else go("/telegram/channels");
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [searching, info, setInfo, go]);

  if (!data) {
    return error ? (
      <div className="flex h-full items-center justify-center p-6">
        <div className="tg-island bg-white p-4">
          <ApiError error={error} retry={() => void refetch()} retrying={isFetching} />
        </div>
      </div>
    ) : (
      <ChatGhost />
    );
  }
  const name = data.title?.trim() || `@${data.username}`;
  const subscribers =
    data.subscribers === null
      ? `@${data.username}`
      : t("subscribers", { count: pluralOf(data.subscribers), formatted: formatCompact(data.subscribers, locale) });
  return (
    <div ref={root} className="absolute inset-0">
      {going && <PageLoadingLine color="telegram" />}
      {/* The chat's column: with 1,276 px of room or more, the chat moves over to make room for the info beside it, as
          in Telegram; with less, the info lies over the chat */}
      <section
        className={cn(
          "absolute inset-y-0 right-0 left-0 transition-[right] duration-300 ease-tg-layer",
          info && "@min-[1276px]/telegram:right-(--tg-right)",
        )}
      >
        <Messages id={id} username={data.username} search={searching ? asked : ""} onHashtag={find} />
        {searching ? (
          <SearchBar field={field} channel={data} name={name} typed={typed} type={type} close={stopSearching} />
        ) : (
          <header className="absolute inset-x-4 top-4 z-20 mx-auto flex h-12 max-w-[728px] items-center rounded-[2rem] bg-white p-1 shadow-tg-pane max-[600px]:inset-x-2 max-[600px]:top-2">
            <PageLink
              line="telegram"
              href="/telegram/channels"
              aria-label={t("back")}
              title={t("back")}
              className="relative mr-1 flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-[rgb(112_117_121/0.08)] @min-[926px]/telegram:hidden"
            >
              <ArrowLeftIcon className="size-6" strokeWidth={1.75} />
              <Ripples />
            </PageLink>
            <button
              type="button"
              onClick={() => setInfo(!info)}
              className="flex min-w-0 flex-1 items-center rounded-full text-left"
            >
              <ChannelPhoto id={id} name={name} url={data.photo_url} size={40} className="mr-2.5" />
              <span className="min-w-0">
                <span className="block truncate text-[17px] leading-6 [font-weight:var(--tg-semibold)]">{name}</span>
                <span
                  className="block truncate text-sm leading-[18px] text-tg-muted"
                  title={data.subscribers === null ? undefined : formatCount(data.subscribers, locale)}
                >
                  {subscribers}
                </span>
              </span>
            </button>
            <RoundButton label={t("search")} onClick={() => setSearching(true)}>
              <SearchIcon className="size-6" strokeWidth={1.75} />
            </RoundButton>
          </header>
        )}
      </section>
      <ChannelInfo
        channel={data}
        name={name}
        subscribers={subscribers}
        open={info}
        close={() => setInfo(false)}
        onHashtag={(tag) => {
          find(tag);
          // Where the info lies over the chat, it goes, to show what's found
          const room = root.current?.closest<HTMLElement>(".telegram")?.clientWidth ?? 0;
          if (room < 1276) setInfo(false);
        }}
      />
    </div>
  );
}

// The search over the chat, in place of its top bar, as Telegram's: the channel's picture, the field, and ✕. The chat
// shows only the messages it finds, with what it found marked.
function SearchBar({
  field,
  channel,
  name,
  typed,
  type,
  close,
}: {
  field: RefObject<HTMLInputElement | null>;
  channel: TelegramChannelDetails;
  name: string;
  typed: string;
  type: (value: string) => void;
  close: () => void;
}) {
  const t = useTranslations("telegramChannel");
  return (
    <div className="absolute inset-x-4 top-4 z-20 mx-auto flex h-12 max-w-[728px] animate-in items-center rounded-[2rem] bg-white py-1 pr-[13px] pl-1 shadow-tg-island duration-200 fade-in max-[600px]:inset-x-2 max-[600px]:top-2 max-[600px]:pr-2">
      <ChannelPhoto
        id={channel.id}
        name={name}
        url={channel.photo_url}
        size={40}
        className="mr-2.5 max-[600px]:hidden"
      />
      <label className="group mr-3 flex h-10 min-w-0 flex-1 items-center rounded-[22px] bg-tg-hover text-[rgb(112_117_121/0.5)] max-[600px]:mr-1">
        <SearchIcon className="ml-3 size-6 shrink-0 group-focus-within:text-tg-blue" strokeWidth={1.75} />
        <input
          ref={field}
          type="search"
          value={typed}
          autoFocus
          onChange={(event) => type(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
          placeholder={t("search")}
          maxLength={SEARCH_MAX}
          enterKeyHint="search"
          aria-label={t("search")}
          className="h-10 min-w-0 flex-1 bg-transparent pt-[5px] pr-3 pb-1.5 pl-2.5 text-base leading-5 text-black caret-tg-blue outline-none placeholder:text-tg-placeholder [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
      <RoundButton label={t("close")} onClick={close}>
        <XIcon className="size-6" strokeWidth={1.75} />
      </RoundButton>
    </div>
  );
}

type ChatDay = { key: number; day: string; messages: TelegramMessage[] };

// The chat itself, under the top bar, where the messages fade as Telegram's do (a mask): the messages, newest first in
// the page, shown bottom up (column-reverse), so that it opens at the newest, as Telegram does, and older pages added
// at the end come in above without moving what's in view. Each day's
// messages are under its date, oldest first, which stays at the top as they go by; as in Telegram, it fades once the
// scrolling stops, and comes back with it. Messages that came out within 10 minutes of each other make a group, whose
// bubbles join, the last with the tail. Scrolled up, the round button at the bottom right goes back down.
function Messages({
  id,
  username,
  search,
  onHashtag,
}: {
  id: number;
  username: string;
  search: string;
  onHashtag: (tag: string) => void;
}) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  const now = useNow();
  const scroller = useRef<HTMLDivElement>(null);
  const [down, setDown] = useState(false); // whether the button down to the newest shows
  const { data, error, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage, refetch, isPlaceholderData } =
    useInfiniteQuery({
      ...telegramChannelMessagesInfiniteOptions({
        path: { channel_id: id },
        query: search ? { search } : undefined,
      }),
      ...FIRST_PAGE,
      getNextPageParam: nextPage("messages"),
      placeholderData: search ? keepPreviousData : undefined,
    });
  const marker = useLoadMore({ more: !!hasNextPage, loading: isFetchingNextPage, load: fetchNextPage, root: scroller });

  // Another search shows its messages from the newest
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [search]);

  // While scrolling: whether to show the button down, and which date is stuck at the top (it shows only while scrolling)
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    let frame = 0;
    let rest: ReturnType<typeof setTimeout> | undefined;
    function look() {
      frame = 0;
      if (!box) return;
      setDown(Math.abs(box.scrollTop) > DOWN_FROM);
      for (const date of box.querySelectorAll<HTMLElement>("[data-date]")) {
        // Stuck: lower than its own place at the top of its day, where its day has gone up past the top bar
        const day = date.parentElement?.getBoundingClientRect().top ?? 0;
        const own = day + parseFloat(getComputedStyle(date).marginTop);
        date.toggleAttribute("data-stuck", date.getBoundingClientRect().top > own + 1);
      }
    }
    function scrolled() {
      box?.setAttribute("data-scrolling", "");
      clearTimeout(rest);
      rest = setTimeout(() => box?.removeAttribute("data-scrolling"), SCROLLING_FOR);
      if (!frame) frame = requestAnimationFrame(look);
    }
    box.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      box.removeEventListener("scroll", scrolled);
      cancelAnimationFrame(frame);
      clearTimeout(rest);
    };
  }, []);

  const messages = data?.pages.flatMap((page) => page.messages) ?? [];
  const days: ChatDay[] = [];
  for (const message of messages) {
    const last = days.at(-1);
    if (last && sameDay(last.messages[0]!.published_at, message.published_at)) last.messages.unshift(message);
    else days.push({ key: message.id, day: formatDay(message.published_at, now, locale), messages: [message] });
  }

  let content: ReactNode;
  if (!data) {
    content = error ? (
      <div className="my-auto self-center">
        <div className="tg-island bg-white p-4">
          <ApiError error={error} retry={() => void refetch()} retrying={isFetching} />
        </div>
      </div>
    ) : (
      <BubblesGhost />
    );
  } else if (messages.length === 0) {
    content = (
      <div className="my-auto self-center">
        <Pill>{search ? t("noneFound") : t("none")}</Pill>
      </div>
    );
  } else {
    content = days.map((day) => (
      <Day key={day.key} day={day} username={username} found={search} onHashtag={onHashtag} />
    ));
  }

  return (
    <>
      <div
        ref={scroller}
        className="group/chat absolute inset-0 flex [scrollbar-width:thin] [scrollbar-color:transparent_transparent] flex-col-reverse overflow-y-auto overscroll-contain [mask-image:linear-gradient(to_bottom,rgb(0_0_0/0.24)_0,rgb(0_0_0/0.24)_40px,#000_64px)] hover:[scrollbar-color:rgb(90_90_90/0.3)_transparent] max-[600px]:[mask-image:linear-gradient(to_bottom,rgb(0_0_0/0.24)_0,rgb(0_0_0/0.24)_32px,#000_56px)]"
      >
        <div
          className={cn(
            "mx-auto flex w-full max-w-[760px] flex-col-reverse px-4 pt-20 pb-4 transition-opacity max-[600px]:px-2 max-[600px]:pt-16",
            isPlaceholderData && DIMMED,
          )}
        >
          {content}
          <div ref={marker} />
          {isFetchingNextPage && <BubblesGhost rows={2} />}
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 mx-auto flex max-w-[760px] justify-end px-4 max-[600px]:px-2">
        <button
          type="button"
          aria-label={t("toNewest")}
          title={t("toNewest")}
          tabIndex={down ? undefined : -1}
          onClick={() => scroller.current?.scrollTo({ top: 0, behavior: "smooth" })}
          className={cn(
            "flex size-14 items-center justify-center rounded-full bg-white text-black shadow-[0_1px_2px_rgb(114_114_114/0.25)] transition-[translate,opacity] duration-[250ms,200ms] ease-tg-spring max-[600px]:size-[46px]",
            down ? "pointer-events-auto translate-y-0 opacity-100" : "translate-y-18 opacity-0",
          )}
        >
          <ArrowDownIcon className="size-7" strokeWidth={1.75} />
        </button>
      </div>
    </>
  );
}

// A day: its date, which stays at the top while its messages go by, and its messages, oldest first
function Day({
  day,
  username,
  found,
  onHashtag,
}: {
  day: ChatDay;
  username: string;
  found: string;
  onHashtag: (tag: string) => void;
}) {
  const times = day.messages.map((message) => Date.parse(message.published_at));
  return (
    <section className="relative">
      <div
        data-date=""
        className="pointer-events-none sticky top-20 z-[9] my-4 flex justify-center transition-opacity duration-300 data-stuck:not-group-data-scrolling/chat:opacity-0 max-[600px]:top-16 max-[600px]:mt-2 max-[600px]:mb-3"
      >
        <Pill>{day.day}</Pill>
      </div>
      {day.messages.map((message, index) => (
        <Bubble
          key={message.id}
          message={message}
          username={username}
          found={found}
          onHashtag={onHashtag}
          first={index === 0 || times[index]! - times[index - 1]! > GROUP_WITHIN}
          last={index === day.messages.length - 1 || times[index + 1]! - times[index]! > GROUP_WITHIN}
        />
      ))}
    </section>
  );
}

// Telegram's small rounded label on the wallpaper: a day's date, or why the chat is empty
function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="pointer-events-auto inline-block rounded-[15px] bg-tg-on-wallpaper px-2 py-[3px] text-[calc(var(--tg-message)-1px)] leading-(--tg-date-leading) font-medium [overflow-wrap:anywhere] text-white">
      {children}
    </span>
  );
}

// A message as Telegram's bubble: white, 15 px corners but where it joins the bubbles of its group, and the last of a
// group with the tail at the bottom left; the text with its links, and the time at the bottom right, after the last
// line when it fits there, below it when not, as in Telegram (a float after the text). Under the mouse (always, on a
// touch screen), the round button at its right opens the post on Telegram, where Telegram's forwards it.
function Bubble({
  message,
  username,
  found,
  onHashtag,
  first,
  last,
}: {
  message: TelegramMessage;
  username: string;
  found: string;
  onHashtag: (tag: string) => void;
  first: boolean;
  last: boolean;
}) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  return (
    <div className={cn("group/message relative flex", last ? "mb-2.5 max-[600px]:mb-[7px]" : "mb-1.5")}>
      <div
        className={cn(
          "relative max-w-[min(29rem,calc(100%-3rem))] rounded-[15px] bg-white px-2 pt-[5px] pb-1.5 shadow-tg-bubble min-[1921px]:max-w-[calc(30vw-1rem)]",
          !first && "rounded-tl-[6px]",
          last ? "rounded-bl-none" : "rounded-bl-[6px]",
        )}
      >
        <p className="text-(length:--tg-message) leading-[1.3125] break-words whitespace-pre-wrap">
          <TelegramText text={message.text.trimEnd()} found={found} onHashtag={onHashtag} />
          <time
            dateTime={message.published_at}
            title={formatDateTime(message.published_at, locale)}
            className="relative top-1.5 float-right -mr-1 ml-2 h-[18px] px-1 text-xs leading-[18px] text-tg-meta"
          >
            {formatClock(message.published_at)}
          </time>
        </p>
        {last && <Tail />}
      </div>
      <a
        href={messageOnTelegram(username, message.id)}
        target="_blank"
        rel="noreferrer"
        aria-label={t("openMessage")}
        title={t("openMessage")}
        className="ml-3 flex size-9 shrink-0 items-center justify-center self-end rounded-full bg-tg-on-wallpaper text-white opacity-0 transition-opacity duration-150 group-hover/message:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <ShareIcon className="size-6" />
      </a>
    </div>
  );
}

// The bubble's tail, at its bottom left, white like it, with its shadow
function Tail() {
  return (
    <svg
      viewBox="0 0 9 17"
      aria-hidden="true"
      className="absolute bottom-0 -left-[9px] h-[17px] w-[9px] fill-white drop-shadow-[0_1px_1px_rgb(16_35_47/0.15)]"
    >
      <path d="M9 0v17H1.6a1 1 0 0 1-.7-1.7C4.6 11.8 8.3 7.2 9 0z" />
    </svg>
  );
}

// The channel's info, as Telegram's panel beside a chat: on the panel's grey, its picture, name and subscribers, then a
// white card with its description, its link (a click copies it, as in Telegram), when it last posted and how many of
// its messages are saved. It slides in from the right; on a phone, over the whole screen.
function ChannelInfo({
  channel,
  name,
  subscribers,
  open,
  close,
  onHashtag,
}: {
  channel: TelegramChannelDetails;
  name: string;
  subscribers: string;
  open: boolean;
  close: () => void;
  onHashtag: (tag: string) => void;
}) {
  const t = useTranslations("telegramChannel");
  const locale = useLocale();
  const { toast } = useTelegram();
  const link = `t.me/${channel.username}`;
  const description = channel.description?.trim();

  // Through the clipboard's own interface, or, where the browser doesn't let the page at it, the old way: from a field
  // out of sight, which takes the focus without moving the page, and gives it back
  async function copy() {
    const address = `https://${link}`;
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      const field = document.createElement("textarea");
      field.value = address;
      field.readOnly = true;
      Object.assign(field.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.body.append(field);
      field.focus({ preventScroll: true });
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      focused?.focus({ preventScroll: true });
      if (!copied) return;
    }
    toast(t("linkCopied"));
  }

  return (
    <aside
      inert={!open}
      aria-label={t("channelInfo")}
      className={cn(
        "absolute inset-0 z-30 flex flex-col overflow-clip bg-tg-hover transition-transform duration-300 ease-tg-layer",
        "@min-[601px]/telegram:inset-auto @min-[601px]/telegram:top-4 @min-[601px]/telegram:right-4 @min-[601px]/telegram:bottom-4 @min-[601px]/telegram:w-[calc(var(--tg-right)-1rem)] @min-[601px]/telegram:tg-island @min-[601px]/telegram:shadow-tg-island",
        open ? "translate-x-0" : "translate-x-[calc(100%+2rem)]",
      )}
    >
      <div className="flex h-16 shrink-0 items-center px-[13px] py-2 max-[600px]:px-2">
        <RoundButton label={t("close")} onClick={close}>
          <XIcon className="size-6" strokeWidth={1.75} />
        </RoundButton>
        <h2 className="ml-[19px] truncate text-xl font-medium">{t("channelInfo")}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="flex flex-col items-center px-6 pt-6 pb-4 text-center">
          <ChannelPhoto id={channel.id} name={name} url={channel.photo_url} size={120} />
          <h3 className="mt-4 text-xl leading-[22px] font-medium [overflow-wrap:anywhere]">{name}</h3>
          <p
            className="mt-1 text-sm text-tg-muted"
            title={channel.subscribers === null ? undefined : formatCount(channel.subscribers, locale)}
          >
            {subscribers}
          </p>
        </div>
        <div className="mx-4 tg-island bg-white p-2 shadow-tg-island">
          {description && (
            <InfoRow icon={InfoIcon} color="gray" label={t("info")}>
              <TelegramText text={description} onHashtag={onHashtag} />
            </InfoRow>
          )}
          <InfoRow icon={LinkIcon} color="orange" label={t("link")} onClick={() => void copy()}>
            {link}
          </InfoRow>
        </div>
        <div className="mx-4 mt-4 tg-island bg-white p-2 shadow-tg-island">
          {channel.last_message_at && (
            <InfoRow icon={ClockIcon} color="blue" label={t("lastPost")}>
              {formatDateTime(channel.last_message_at, locale)}
            </InfoRow>
          )}
          <InfoRow icon={MessageSquareTextIcon} color="green" label={t("savedMessages")}>
            {formatCount(channel.messages, locale)}
          </InfoRow>
        </div>
      </div>
    </aside>
  );
}
