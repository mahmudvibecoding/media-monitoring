"use client";

import { useMutation } from "@tanstack/react-query";
import { ChevronsUpDownIcon, CircleUserIcon, LogOutIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import { signOutMutation } from "@/api/@tanstack/react-query.gen";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { setLocale } from "@/i18n/actions";
import { localeNames, locales } from "@/i18n/config";

// At the foot of the admins' menu: who's signed in, and a menu with the site's language and signing out. Choosing a
// language brings the page back in it; signing out loads the sign-in page anew, which also drops whatever this tab
// kept of the account's data.
export function UserMenu({ name }: { name: string }) {
  const t = useTranslations("header");
  const locale = useLocale();
  const [, startTransition] = useTransition();
  const signOut = useMutation(signOutMutation());
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton aria-label={name} />}>
            <CircleUserIcon />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <ChevronsUpDownIcon className="ml-auto text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="min-w-52">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("language")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={locale} onValueChange={(value) => startTransition(() => setLocale(value))}>
                {locales.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option} lang={option}>
                    {localeNames[option]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={signOut.isPending}
              // A full load, not Next's router: it drops all that the tab kept of the account
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              onClick={() => signOut.mutate({}, { onSettled: () => window.location.assign("/sign-in") })}
            >
              <LogOutIcon />
              {t("signOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
