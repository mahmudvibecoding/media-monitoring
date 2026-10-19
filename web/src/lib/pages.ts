// Lists that load more as they're scrolled (a channel's videos, a video's comments, a channel's messages) ask for page 1
// first, on the server too, then for the next one while the last was full
export const FIRST_PAGE = { initialPageParam: 1 };

// A list while the one that replaces it loads (placeholderData: keepPreviousData): dimmed, but only once that takes more
// than a moment, so a list that's there at once doesn't flash; it comes back at once
export const DIMMED = "opacity-60 delay-150";

export function nextPage<K extends string>(items: K) {
  return (last: { [key in K]: unknown[] } & { page_size: number }, all: unknown[]) =>
    last[items].length === last.page_size ? all.length + 1 : undefined;
}
