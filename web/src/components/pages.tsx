"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";

// Under a list: which page of how many, and buttons to the one before and the next. ← and → turn the pages too, unless
// one's typing somewhere.
export function Pages({ page, pages, turn }: { page: number; pages: number; turn: (to: number) => void }) {
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
      <p className="text-sm text-muted-foreground tabular-nums">
        {t("page", { page: formatCount(page, locale), pages: formatCount(pages, locale) })}
      </p>
      <div className="flex gap-1">
        {buttons.map(({ to, label, icon: Icon, off }) => (
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
        ))}
      </div>
    </div>
  );
}
