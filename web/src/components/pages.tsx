"use client";

import { ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";

// Under a list: which page of how many, and buttons to the first, the one before, the next and the last
export function Pages({ page, pages, turn }: { page: number; pages: number; turn: (to: number) => void }) {
  const t = useTranslations("pages");
  const locale = useLocale();
  const buttons = [
    { to: 1, label: t("first"), icon: ChevronsLeftIcon, off: page <= 1 },
    { to: page - 1, label: t("previous"), icon: ChevronLeftIcon, off: page <= 1 },
    { to: page + 1, label: t("next"), icon: ChevronRightIcon, off: page >= pages },
    { to: pages, label: t("last"), icon: ChevronsRightIcon, off: page >= pages },
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
