"use client";

import { useState, useSyncExternalStore } from "react";

import { searchOf } from "@/lib/address";

function subscribe(changed: () => void) {
  window.addEventListener("popstate", changed);
  return () => window.removeEventListener("popstate", changed);
}
const inAddress = () => searchOf(new URLSearchParams(window.location.search));

// A search box whose text goes into the address at each key (write, given what's typed and what the address has now),
// and which follows the address's search (search, as the page has it) when that changes some other way: a link, Back.
// The page has what was written a moment after the key (Next hands it over in a transition), so it can show what the
// box wrote a few keys before: the box keeps a list of what it has written until the page has caught up with the
// address, and doesn't follow the page back through it, which would put back what was in the box before the last
// keys. While follow is off (the top bar's box on another page than the list), the text is the box's own; it takes
// the address's search again once follow is back on. adopt hears of a search taken from the address.
export function useSearchBox({
  search,
  follow,
  write,
  adopt,
}: {
  search: string;
  follow: boolean;
  write: (typed: string, now: string) => void;
  adopt?: (search: string) => void;
}) {
  const address = useSyncExternalStore(subscribe, inAddress, () => search);
  const [text, setText] = useState(follow ? search : "");
  const [shown, setShown] = useState<string | null>(follow ? search : null); // the page's search the box last saw
  const [written, setWritten] = useState<string[]>([]); // what it has written since, oldest first
  if (!follow && shown !== null) setShown(null);
  if (follow && search !== shown) {
    setShown(search);
    if (shown === null || !written.includes(search)) {
      setText(search);
      setWritten([]);
      adopt?.(search);
    }
  }
  if (follow && written.length > 0 && search === address) setWritten([]); // the page has caught up

  function type(value: string) {
    setText(value);
    if (!follow) return;
    const typed = searchOf(new URLSearchParams({ search: value }));
    const now = inAddress();
    if (typed === now) return; // only spaces changed
    setWritten((last) => [...last, typed]);
    write(typed, now);
  }

  return [text, type] as const;
}
