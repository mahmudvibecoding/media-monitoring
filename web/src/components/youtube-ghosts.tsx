import type { CSSProperties } from "react";

import { Skeleton } from "@/components/ui/skeleton";

// A Short's page's shape in grey, as YouTube shows it while the Shorts load, under its top bar, which stays; and the
// watch page's grid

// The watch page's columns: the video's column, as wide as the page allows but no wider than the player may be, and,
// from 1,000 px of the page's width (a container), the next videos' column beside it, which runs down past the
// comments; below that width, one column, with the next videos between the description and the comments, as on
// YouTube. Both stay together in the middle of the page.
export const WATCH_GRID =
  "grid grid-cols-[minmax(0,var(--player-max))] justify-center gap-x-4 gap-y-6 [grid-template-areas:'main'_'side'_'comments'] @min-[1000px]:grid-cols-[minmax(0,var(--player-max))_clamp(320px,30%,402px)] @min-[1000px]:grid-rows-[auto_1fr] @min-[1000px]:[grid-template-areas:'main_side'_'comments_side']";
// The player's widest: 16:9 of the screen's height but for the top bar (56 px), the space above the player (12 px) and
// under it (48 px), as YouTube sizes it
export const PLAYER_MAX = { "--player-max": "max(640px, calc((100dvh - 116px) * 16 / 9))" } as CSSProperties;

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
