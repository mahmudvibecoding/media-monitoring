"use client";

import { LanguagesIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setLocale } from "@/i18n/actions";
import { localeNames, locales } from "@/i18n/config";

// The language menu in the header, with each language under its own name. Choosing one closes the menu, and the page
// comes back in that language.
export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations("header");
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  function choose(value: string) {
    setOpen(false);
    startTransition(() => setLocale(value));
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={`${t("language")}: ${localeNames[locale]}`}
        render={<Button variant="ghost" size="sm" />}
      >
        <LanguagesIcon />
        {localeNames[locale]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={locale} onValueChange={choose}>
          {locales.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} lang={option}>
              {localeNames[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
