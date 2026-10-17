"use client";

import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { SEARCH_MAX, searchOf } from "@/lib/address";

const SEARCH_WAIT = 300; // milliseconds after the last key before the list is searched

// A list's search box: onSearch gets the search a moment after the last key, to put in the address, so that Back and a
// copied link bring it back. When the address's search changes some other way (Back, Forward, the menu), the box
// follows it.
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
  useEffect(() => () => clearTimeout(timer.current), []);

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

  return (
    <div className="relative w-full sm:w-80">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={text}
        onChange={(event) => type(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={SEARCH_MAX}
        className="pl-8"
      />
    </div>
  );
}
