import type { CSSProperties } from "react";

import { Skeleton } from "@/components/ui/skeleton";

// YouTube's pages' shapes in grey, as YouTube shows them while a page loads, under its top bar, which stays; and the
// watch page's grid, which the page and its shape share

// The watch page's columns: the video's column, as wide as the page allows but no wider than the player may be, and,
// from 1,000 px of the page's width (a container), the next videos' column beside it, which runs down past the
// comments; below that width, one column, with the next videos between the description and the comments, as on
// YouTube. Both stay together in the middle of the page.
export const WATCH_GRID =
  "grid grid-cols-[minmax(0,var(--player-max))] justify-center gap-x-4 gap-y-6 [grid-template-areas:'main'_'side'_'comments'] @min-[1000px]:grid-cols-[minmax(0,var(--player-max))_clamp(320px,30%,402px)] @min-[1000px]:grid-rows-[auto_1fr] @min-[1000px]:[grid-template-areas:'main_side'_'comments_side']";
// The player's widest: 16:9 of the screen's height but for the top bar (56 px), the space above the player (12 px) and
// under it (48 px), as YouTube sizes it
export const PLAYER_MAX = { "--player-max": "max(640px, calc((100dvh - 116px) * 16 / 9))" } as CSSProperties;

// A video's page: the player, the title, the channel, the description's box, and the next videos beside
export function WatchGhost({ label }: { label: string }) {
  return (
    <div className="@container px-4 pt-3" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className={WATCH_GRID} style={PLAYER_MAX}>
        <div className="min-w-0 [grid-area:main]">
          <Skeleton className="aspect-video rounded-xl" />
          <Skeleton className="mt-3 h-7 w-3/4 rounded-lg" />
          <div className="mt-3 flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Skeleton className="mt-3 h-[104px] rounded-xl" />
        </div>
        <div className="min-w-0 space-y-2 [grid-area:side]">
          {Array.from({ length: 6 }, (_, row) => (
            <div key={row} className="flex gap-3">
              <Skeleton className="aspect-video w-[min(248px,58%)] shrink-0 rounded-lg" />
              <div className="flex-1 space-y-2 pt-1">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// A Short's page: the upright player in the middle, with YouTube's round buttons beside it, and the arrows' column at
// the right
export function ShortsGhost({ label }: { label: string }) {
  return (
    <div className="flex h-[calc(100svh-3.5rem)]" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="flex min-w-0 flex-1 justify-center px-4 pt-2 pb-8">
        <div className="flex h-full items-end gap-3">
          <Skeleton
            className="h-full rounded-xl"
            style={{ aspectRatio: "9 / 16", maxHeight: "calc((100vw - 32px) * 16 / 9)" }}
          />
          <div className="flex flex-col gap-4 max-sm:hidden">
            {Array.from({ length: 3 }, (_, button) => (
              <div key={button} className="flex flex-col items-center gap-1">
                <Skeleton className="size-12 rounded-full" />
                <Skeleton className="h-3 w-8" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="hidden w-20 shrink-0 md:block" />
    </div>
  );
}

// A channel's page: its picture and name, the tabs, the chips and a grid of covers
export function ChannelGhost({ label }: { label: string }) {
  return (
    <div className="@container mx-auto max-w-[1284px] px-4 sm:px-6" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="flex items-center gap-4 pt-4">
        <Skeleton className="size-[72px] shrink-0 rounded-full sm:size-40" />
        <div className="flex-1 space-y-3">
          <Skeleton className="h-9 w-64 max-w-full rounded-lg" />
          <Skeleton className="h-4 w-80 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
      </div>
      <div className="mt-4 flex h-12 items-center gap-6 border-b border-yt-divider">
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-4 w-14" />
      </div>
      <div className="flex gap-2 pt-4 pb-6">
        {[16, 24, 16].map((width, chip) => (
          <Skeleton key={chip} className="h-8 rounded-lg" style={{ width: width * 4 }} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-8 @min-[500px]:grid-cols-2 @min-[860px]:grid-cols-3 @min-[1200px]:grid-cols-4">
        {Array.from({ length: 8 }, (_, card) => (
          <div key={card} className="space-y-3">
            <Skeleton className="aspect-video rounded-xl" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}

// The channels' list: round pictures with their names, as many as fill the screen
export function ChannelsGhost({ label }: { label: string }) {
  return (
    <div
      className="grid h-[calc(100svh-3.5rem)] grid-cols-[repeat(auto-fill,minmax(160px,1fr))] content-start gap-4 overflow-hidden px-4 pt-3 sm:px-6"
      aria-busy="true"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: 24 }, (_, tile) => (
        <div key={tile} className="flex h-[208px] flex-col items-center gap-3 pt-3">
          <Skeleton className="size-24 rounded-full" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}
