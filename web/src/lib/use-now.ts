"use client";

import { useSyncExternalStore } from "react";

const MINUTE = 60_000;

function subscribe(tick: () => void) {
  const timer = setInterval(tick, MINUTE / 4); // looks four times a minute, so a new minute shows soon after it starts
  return () => clearInterval(timer);
}
const minute = () => Math.floor(Date.now() / MINUTE) * MINUTE;
const none = () => null;

// The current minute (milliseconds since 1970), in the browser only: null while the server renders a page and while the
// browser takes it over, so both write the same, then the minute, moving on by itself. "3 min ago" is counted from it;
// the server can't read the clock while Next prerenders a page.
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, minute, none);
}
