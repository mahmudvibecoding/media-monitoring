import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768; // pixels wide
const MOBILE = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void) {
  const media = window.matchMedia(MOBILE);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

// Whether the screen is a phone's, for shadcn's sidebar (which shows itself as a sheet there). shadcn's own version
// sets state in an effect, which React's rules refuse; this follows the media query the way React provides for it.
// The server, which can't know, renders for a wider screen, as shadcn's does.
export function useIsMobile() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE).matches,
    () => false,
  );
}
