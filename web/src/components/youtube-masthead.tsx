"use client";

import { keepPreviousData, type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, MenuIcon, SearchIcon, XIcon } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { youtubeChannelsOptions, youtubeVideoQueryKey } from "@/api/@tanstack/react-query.gen";
import type { YouTubeChannel, YouTubeVideoDetails } from "@/api/types.gen";
import { YouTubeLogo } from "@/components/brand-icons";
import { PageLoadingLine, useGo } from "@/components/page-link";
import { useSidebar } from "@/components/ui/sidebar";
import { ChannelPicture, Dot, YouTubeLink, YouTubeTip, YT_ICON_BUTTON } from "@/components/youtube-ui";
import { go, SEARCH_MAX, searchOf } from "@/lib/address";
import { formatCompact, pluralOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { channelsAddress } from "@/lib/youtube";

const LIST = "/youtube/channels"; // the channels' list, where the logo goes and the search searches
const SEARCH_WAIT = 300; // milliseconds after the last key before the list is searched
const SUGGEST_WAIT = 150; // and before channels are suggested
const SUGGESTIONS = 8;

// What a page has put in the cache for a query, read without asking for it, and without making the query either: a
// query made here, before the page's own, would keep the page from what came with it until after its first render
// (TanStack Query hands what came with a page to a query that's there already only then), so it would first show its
// grey shape. Nothing on the server, nor on the browser's first render, which follows the server's.
function useCached<T>(queryKey: QueryKey): T | undefined {
  const client = useQueryClient();
  return useSyncExternalStore(
    (changed) => client.getQueryCache().subscribe(changed),
    () => client.getQueryData<T>(queryKey),
    () => undefined,
  );
}

// YouTube's top bar over its pages here, as YouTube's own: 56 px high, white, staying at the top as the page scrolls,
// and the same from page to page. At its left, on a phone, the menu's button (as YouTube's ☰), then the way up (from a
// video to its channel, from a Short to its channel's Shorts, from a channel to the channels) and the logo, which goes
// to the channels; in its middle, the search box. On the channels' list the box searches them as one types; elsewhere
// it suggests channels as one types, as YouTube suggests searches, and searches the list on Enter. On a phone, the box
// is a button that opens it across the bar.
export function YouTubeMasthead() {
  const common = useTranslations("common");
  const nav = useTranslations("nav");
  const t = useTranslations("youtube");
  const path = usePathname();
  const [, page, video] = /^\/youtube\/(videos|shorts)\/([^/]+)/.exec(path) ?? [];
  const channel = /^\/youtube\/channels\/([^/]+)/.exec(path)?.[1];
  // A video's channel, from its details, which its page has put in the cache
  const videoChannel = useCached<YouTubeVideoDetails>(
    youtubeVideoQueryKey({ path: { video_id: video ?? "" } }),
  )?.channel_id;
  let up = channel ? LIST : null;
  if (video) up = videoChannel ? `${LIST}/${videoChannel}${page === "shorts" ? "?kind=short" : ""}` : LIST;
  const { toggleSidebar } = useSidebar();
  const [searching, setSearching] = useState(false); // on a phone, the box open across the bar

  return (
    <>
      {searching && (
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 bg-white px-2 font-roboto text-yt-text sm:hidden">
          <button
            type="button"
            onClick={() => setSearching(false)}
            aria-label={common("back")}
            className={YT_ICON_BUTTON}
          >
            <ArrowLeftIcon className="size-6" strokeWidth={1.5} />
          </button>
          <Search list={path === LIST} autoFocus className="flex-1" />
        </header>
      )}
      <header
        className={cn(
          "sticky top-0 z-30 grid h-14 grid-cols-[minmax(max-content,1fr)_auto] items-center gap-x-4 bg-white px-4 font-roboto text-yt-text sm:grid-cols-[minmax(max-content,1fr)_minmax(0,40rem)_minmax(0,1fr)]",
          searching && "hidden sm:grid",
        )}
      >
        <div className="flex items-center">
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={nav("toggle")}
            className={cn(YT_ICON_BUTTON, "md:hidden")}
          >
            <MenuIcon className="size-6" strokeWidth={1.5} />
          </button>
          {up && (
            <YouTubeTip label={common("back")}>
              <YouTubeLink href={up} aria-label={common("back")} className={YT_ICON_BUTTON}>
                <ArrowLeftIcon className="size-6" strokeWidth={1.5} />
              </YouTubeLink>
            </YouTubeTip>
          )}
          <YouTubeLink
            href={LIST}
            aria-label="YouTube"
            className={cn("flex h-14 items-center pr-3.5 pl-4", !up && "md:pl-0")}
          >
            <YouTubeLogo className="h-5 w-[93px] text-yt-text" />
          </YouTubeLink>
        </div>
        <Search list={path === LIST} className="hidden sm:block" />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setSearching(true)}
            aria-label={t("search")}
            className={cn(YT_ICON_BUTTON, "sm:hidden")}
          >
            <SearchIcon className="size-6" strokeWidth={1.5} />
          </button>
        </div>
      </header>
    </>
  );
}

// YouTube's search box: a long rounded field and its grey button. While typing in it, the field takes in the button's
// margin at its left, with the magnifier in it, and is outlined in blue; a cross empties it. On the channels' list
// (list), it searches the list a moment after the last key, through the address, so that Back and a copied link bring
// the search back, and it follows the address when that changes some other way. Elsewhere it suggests channels under
// it as one types (↑ and ↓ go through them, Enter or a click opens one), and Enter searches the list. "/" anywhere goes
// to it.
function Search({ list, autoFocus = false, className }: { list: boolean; autoFocus?: boolean; className?: string }) {
  const t = useTranslations("youtube");
  const [navigate, navigating] = useGo(); // to another page (a channel, or the list's search)
  const search = searchOf(useSearchParams());
  const [text, setText] = useState(list ? search : "");
  const [written, setWritten] = useState(search); // the search this box last put in the address
  if (list && search !== written) {
    setWritten(search);
    setText(search);
  }
  const [focused, setFocused] = useState(false);
  const [asked, setAsked] = useState(""); // what the suggestions are for, a moment after the last key
  const [active, setActive] = useState(-1); // the suggestion ↑ and ↓ have reached
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listbox = useId();
  useEffect(() => () => clearTimeout(timer.current), []);

  // "/" goes to the box, unless one's typing somewhere already
  useEffect(() => {
    function slash(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (!input.current?.offsetParent) return; // the box that's hidden on this screen
      event.preventDefault();
      input.current.focus();
    }
    window.addEventListener("keydown", slash);
    return () => window.removeEventListener("keydown", slash);
  }, []);

  const { data } = useQuery({
    ...youtubeChannelsOptions({ query: { search: asked, size: SUGGESTIONS } }),
    enabled: !list && asked !== "",
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const suggestions = !list && focused && asked !== "" && text.trim() ? (data?.channels ?? []) : [];

  function type(value: string) {
    setText(value);
    setActive(-1);
    clearTimeout(timer.current);
    const next = searchOf(new URLSearchParams({ search: value }));
    if (list) {
      timer.current = setTimeout(() => {
        if (next === written) return; // only spaces changed
        setWritten(next);
        go(channelsAddress({ search: next || undefined }), "replace");
      }, SEARCH_WAIT);
    } else {
      timer.current = setTimeout(() => setAsked(next), SUGGEST_WAIT);
    }
  }

  function clear() {
    type("");
    clearTimeout(timer.current);
    if (list && written) {
      setWritten("");
      go(channelsAddress({}), "replace");
    }
    input.current?.focus();
  }

  function open(channel: YouTubeChannel) {
    setFocused(false);
    input.current?.blur();
    navigate(`${LIST}/${channel.id}`);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const picked = suggestions[active];
    if (picked) return open(picked);
    const next = searchOf(new URLSearchParams({ search: text }));
    clearTimeout(timer.current);
    input.current?.blur();
    if (list) {
      setWritten(next);
      go(channelsAddress({ search: next || undefined }), "replace");
    } else {
      navigate(`${LIST}${channelsAddress({ search: next || undefined })}`);
    }
  }

  function keys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (suggestions.length) setFocused(false);
      else if (list && text) clear();
      else input.current?.blur();
    } else if (suggestions.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((last) => ((last + step + 1 + suggestions.length + 1) % (suggestions.length + 1)) - 1);
    }
  }

  return (
    <form role="search" onSubmit={submit} className={cn("group/search relative h-10 w-full", className)}>
      {navigating && <PageLoadingLine color="youtube" />}
      <div className="flex h-full w-full pl-8 group-focus-within/search:pl-0">
        <div className="relative flex min-w-0 flex-1 items-center rounded-l-full border border-yt-field bg-white pr-1 pl-4 shadow-[inset_0_1px_2px_#eeeeee] group-focus-within/search:border-yt-focus group-focus-within/search:pl-12 group-focus-within/search:shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)]">
          <SearchIcon
            className="absolute left-4 hidden size-5 group-focus-within/search:block"
            strokeWidth={1.75}
            aria-hidden="true"
          />
          <input
            ref={input}
            type="text"
            value={text}
            autoFocus={autoFocus}
            onChange={(event) => type(event.target.value)}
            onKeyDown={keys}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={t("search")}
            aria-label={t("search")}
            maxLength={SEARCH_MAX}
            autoComplete="off"
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls={listbox}
            aria-activedescendant={active >= 0 ? `${listbox}-${active}` : undefined}
            className="h-full w-full min-w-0 bg-transparent text-base leading-[22px] text-yt-text outline-none placeholder:text-yt-placeholder"
          />
          {text && (
            <YouTubeTip label={t("clearSearch")}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={clear}
                aria-label={t("clearSearch")}
                className={cn(YT_ICON_BUTTON, "size-9")}
              >
                <XIcon className="size-6" strokeWidth={1.25} />
              </button>
            </YouTubeTip>
          )}
        </div>
        <YouTubeTip label={t("search")}>
          <button
            type="submit"
            aria-label={t("search")}
            className="flex h-10 w-16 shrink-0 items-center justify-center rounded-r-full border border-l-0 border-yt-field bg-[#f8f8f8] text-yt-text hover:border-[#c6c6c6] hover:bg-[#f0f0f0] hover:shadow-[0_1px_0_rgba(0,0,0,0.1)]"
          >
            <SearchIcon className="size-6" strokeWidth={1.5} />
          </button>
        </YouTubeTip>
      </div>
      {suggestions.length > 0 && (
        <ul
          id={listbox}
          role="listbox"
          aria-label={t("search")}
          onMouseDown={(event) => event.preventDefault()} // a click on a suggestion mustn't take the focus first
          className="absolute top-11 right-16 left-0 z-40 rounded-xl bg-white py-2 shadow-[0_2px_4px_rgba(0,0,0,0.2)]"
        >
          {suggestions.map((suggestion, index) => (
            <Suggestion
              key={suggestion.id}
              id={`${listbox}-${index}`}
              channel={suggestion}
              typed={text.trim()}
              active={index === active}
              onPick={() => open(suggestion)}
            />
          ))}
        </ul>
      )}
    </form>
  );
}

// A suggested channel, as YouTube suggests a search: the magnifier, the name, what was typed in it plain and the rest
// in bold, its handle and subscribers under it, and its picture at the right
function Suggestion({
  id,
  channel,
  typed,
  active,
  onPick,
}: {
  id: string;
  channel: YouTubeChannel;
  typed: string;
  active: boolean;
  onPick: () => void;
}) {
  const channelTexts = useTranslations("youtubeChannel");
  const locale = useLocale();
  const name = channel.title?.trim() || channel.id;
  const at = name.toLocaleLowerCase(locale).indexOf(typed.toLocaleLowerCase(locale));
  const parts =
    at < 0 || !typed
      ? [{ text: name, bold: true }]
      : [
          { text: name.slice(0, at), bold: true },
          { text: name.slice(at, at + typed.length), bold: false },
          { text: name.slice(at + typed.length), bold: true },
        ];
  return (
    <li
      id={id}
      role="option"
      aria-selected={active}
      onClick={onPick}
      className={cn(
        "flex cursor-pointer items-center gap-3.5 py-1.5 pr-4 pl-4 hover:bg-yt-chip",
        active && "bg-yt-chip",
      )}
    >
      <SearchIcon className="size-5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base leading-[22px]">
          {parts.map((part, index) =>
            part.text ? (
              <span key={index} className={part.bold ? "font-medium" : undefined}>
                {part.text}
              </span>
            ) : null,
          )}
        </p>
        <p className="truncate text-xs leading-[18px] text-yt-muted">
          {channel.handle}
          {channel.handle && channel.subscribers !== null && <Dot />}
          {channel.subscribers !== null &&
            channelTexts("subscribers", {
              count: pluralOf(channel.subscribers),
              formatted: formatCompact(channel.subscribers, locale),
            })}
        </p>
      </div>
      <ChannelPicture url={channel.avatar_url} size={32} />
    </li>
  );
}
