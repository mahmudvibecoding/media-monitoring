"use client";

import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SEARCH_MAX, searchOf } from "@/lib/address";
import { cn } from "@/lib/utils";

const SEARCH_WAIT = 300; // milliseconds after the last key before the list is searched

// A list's search box, looking like Telegram's (YouTube's pages have YouTube's, in their top bar): onSearch gets the
// search a moment after the last key, to put in the address, so that Back and a copied link bring it back. When the
// address's search changes some other way (Back, Forward, the menu), the box follows it. "/" anywhere on the page goes
// to it, and Escape empties it.
export function SearchBox({
  search,
  placeholder,
  onSearch,
}: {
  search: string;
  placeholder: string;
  onSearch: (search: string) => void;
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

  // Telegram's: a grey rounded field with the magnifier inside, outlined in blue while typing in it
  return (
    <div className="flex h-10 w-full max-w-md items-center gap-2 rounded-full border-2 border-transparent bg-tg-hover px-3 font-roboto text-tg-muted focus-within:border-tg-blue focus-within:bg-white focus-within:text-tg-blue">
      <SearchIcon className="size-5 shrink-0" strokeWidth={1.75} />
      {field}
    </div>
  );
}
