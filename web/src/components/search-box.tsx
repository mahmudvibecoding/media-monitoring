"use client";

import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SEARCH_MAX, searchOf } from "@/lib/address";
import { cn } from "@/lib/utils";

const SEARCH_WAIT = 300; // milliseconds after the last key before the list is searched

// A list's search box, looking like YouTube's or like Telegram's: onSearch gets the search a moment after the last key,
// to put in the address, so that Back and a copied link bring it back; or, with onEnter, only on Enter or a click on
// its button (a box that takes one to the list). When the address's search changes some other way (Back, Forward, the
// menu), the box follows it. "/" anywhere on the page goes to it, and Escape empties it.
export function SearchBox({
  search,
  placeholder,
  onSearch,
  onEnter = false,
  look,
}: {
  search: string;
  placeholder: string;
  onSearch: (search: string) => void;
  onEnter?: boolean;
  look: "youtube" | "telegram";
}) {
  const [text, setText] = useState(search);
  const [written, setWritten] = useState(search); // the search this box last put in the address
  if (search !== written) {
    setWritten(search);
    setText(search);
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  // "/" goes to the box, unless one's typing somewhere already
  useEffect(() => {
    function slash(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      event.preventDefault();
      input.current?.focus();
    }
    window.addEventListener("keydown", slash);
    return () => window.removeEventListener("keydown", slash);
  }, []);

  function type(value: string) {
    setText(value);
    if (onEnter) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = searchOf(new URLSearchParams({ search: value }));
      if (next === written) return; // only spaces changed
      setWritten(next);
      onSearch(next);
    }, SEARCH_WAIT);
  }

  const field = (
    <input
      ref={input}
      type="search"
      value={text}
      onChange={(event) => type(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && text) type("");
        if (event.key === "Enter" && onEnter) onSearch(searchOf(new URLSearchParams({ search: text })));
      }}
      placeholder={placeholder}
      aria-label={placeholder}
      maxLength={SEARCH_MAX}
      className={cn(
        "h-10 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground sm:text-sm",
        "[&::-webkit-search-cancel-button]:hidden",
      )}
    />
  );

  if (look === "youtube") {
    // YouTube's: a long rounded field with a grey button at its end
    return (
      <div className="flex w-full max-w-xl font-roboto">
        <div className="flex h-10 min-w-0 flex-1 items-center rounded-l-full border border-[#d3d3d3] bg-white pl-4 focus-within:border-[#1c62b9] focus-within:shadow-[inset_0_1px_2px_rgba(0,0,0,0.15)]">
          {field}
        </div>
        <button
          type="button"
          aria-label={placeholder}
          onClick={() => (onEnter ? onSearch(searchOf(new URLSearchParams({ search: text }))) : input.current?.focus())}
          className="flex h-10 w-16 shrink-0 items-center justify-center rounded-r-full border border-l-0 border-[#d3d3d3] bg-[#f8f8f8] text-yt-text hover:bg-yt-chip-hover"
        >
          <SearchIcon className="size-5" strokeWidth={1.75} />
        </button>
      </div>
    );
  }
  // Telegram's: a grey rounded field with the magnifier inside, outlined in blue while typing in it
  return (
    <div className="flex h-10 w-full max-w-md items-center gap-2 rounded-full border-2 border-transparent bg-tg-hover px-3 font-roboto text-tg-muted focus-within:border-tg-blue focus-within:bg-white focus-within:text-tg-blue">
      <SearchIcon className="size-5 shrink-0" strokeWidth={1.75} />
      {field}
    </div>
  );
}
