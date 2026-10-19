"use client";

import Link, { useLinkStatus } from "next/link";
import { useRouter } from "next/navigation";
import { type ComponentProps, useCallback, useTransition } from "react";

import { cn } from "@/lib/utils";

// The line along the top of the window while the next page is on its way: YouTube's red on YouTube's pages, Telegram's
// blue on Telegram's, the site's own dark grey elsewhere. It shows only once the page takes more than a moment
// (globals.css's page-loading), so a page that's ready at once shows none.
const LINE = { youtube: "bg-yt-red", telegram: "bg-tg-blue", site: "bg-foreground/70" } as const;
export type LineColor = keyof typeof LINE;

// The line of the pages an address leads to
export const lineFor = (href: string): LineColor =>
  href.startsWith("/youtube") ? "youtube" : href.startsWith("/telegram") ? "telegram" : "site";

export function PageLoadingLine({ color }: { color: LineColor }) {
  return (
    <span
      aria-hidden="true"
      className={cn("fixed inset-x-0 top-0 z-50 h-0.5 origin-left animate-page-loading", LINE[color])}
    />
  );
}

// A link to another page here. The page it's on stays as it is until the next one is ready, as on YouTube, with no
// grey placeholder between them (the routes have no loading.tsx: React keeps one up for at least 300 ms, however
// quickly the page comes); the line along the top says it's on its way. From the click until then, the link holds an
// element with data-pending, so that what was clicked can show it at once (a menu's item, a chat's row).
export function PageLink({ line = "site", children, ...props }: ComponentProps<typeof Link> & { line?: LineColor }) {
  return (
    <Link {...props}>
      {children}
      <Pending color={line} />
    </Link>
  );
}

// For a page opened otherwise than by a link (a key, the player's next video, a search): go(href) opens it as a
// link would, and pending says it's on its way, for the line along the top
export function useGo(): [go: (href: string) => void, pending: boolean] {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const go = useCallback((href: string) => startTransition(() => router.push(href)), [router]);
  return [go, pending];
}

function Pending({ color }: { color: LineColor }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <>
      <span data-pending="" hidden />
      <PageLoadingLine color={color} />
    </>
  );
}
