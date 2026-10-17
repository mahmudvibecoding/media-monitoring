"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

// Under a list: which page of how many (after what's said before it), and buttons to the one before and the next, in
// the site's look or in YouTube's (round grey buttons). ← and → turn the pages too, unless one's typing somewhere.
export function Pages({
  page,
  pages,
  turn,
  before,
  look,
}: {
  page: number;
  pages: number;
  turn: (to: number) => void;
  before?: string;
  look?: "youtube";
}) {
  const t = useTranslations("pages");
  const locale = useLocale();
  useEffect(() => {
    function arrow(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.key === "ArrowLeft" && page > 1) turn(page - 1);
      else if (event.key === "ArrowRight" && page < pages) turn(page + 1);
    }
    window.addEventListener("keydown", arrow);
    return () => window.removeEventListener("keydown", arrow);
  }, [page, pages, turn]);
  const buttons = [
    { to: page - 1, label: t("previous"), icon: ChevronLeftIcon, off: page <= 1 },
    { to: page + 1, label: t("next"), icon: ChevronRightIcon, off: page >= pages },
  ];
  return (
    <div className="flex items-center justify-between gap-4">
      <p className={cn("text-sm tabular-nums", look === "youtube" ? "text-yt-muted" : "text-muted-foreground")}>
        {before && `${before} · `}
        {t("page", { page: formatCount(page, locale), pages: formatCount(pages, locale) })}
      </p>
      <div className={cn("flex", look === "youtube" ? "gap-2" : "gap-1")}>
        {buttons.map(({ to, label, icon: Icon, off }) =>
          look === "youtube" ? (
            <button
              key={label}
              type="button"
              aria-label={label}
              disabled={off}
              onClick={() => turn(to)}
              className="flex size-10 items-center justify-center rounded-full bg-yt-chip text-yt-text hover:bg-yt-chip-hover disabled:opacity-40 disabled:hover:bg-yt-chip"
            >
              <Icon className="size-6" />
            </button>
          ) : (
            <Button
              key={label}
              variant="outline"
              size="icon-sm"
              aria-label={label}
              disabled={off}
              onClick={() => turn(to)}
            >
              <Icon />
            </Button>
          ),
        )}
      </div>
    </div>
  );
}
