"use client";

import { type RefObject, useEffect, useRef } from "react";

// For a list that loads more as it's scrolled: a marker to put after its last item, which asks for the next page once
// it comes within 600 px of the screen, or of the edge of root, a box that scrolls by itself (Telegram's messages)
export function useLoadMore({
  more,
  loading,
  load,
  root,
}: {
  more: boolean; // whether there's another page
  loading: boolean; // whether it's on its way
  load: () => unknown;
  root?: RefObject<HTMLElement | null>;
}) {
  const marker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = marker.current;
    if (!element || !more || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      },
      { root: root?.current ?? null, rootMargin: "600px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, loading, load, root]);
  return marker;
}
