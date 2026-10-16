import Link from "next/link";
import { getTranslations } from "next-intl/server";

import type { Me } from "@/api/types.gen";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SignOutButton } from "@/components/sign-out-button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

// The top of every page: the site's name, the language menu, and, once someone's signed in, their name and signing out.
// Beside the admins' menu (sidebar), which has the site's name, it starts with the button that folds the menu, or, on
// a phone, opens it.
export async function Header({ user, sidebar = false }: { user?: Me; sidebar?: boolean }) {
  const t = await getTranslations();
  return (
    <header className="border-b">
      <div className={cn("flex h-14 items-center justify-between gap-4 px-6", !sidebar && "mx-auto max-w-7xl")}>
        {sidebar ? (
          <SidebarTrigger aria-label={t("nav.toggle")} className="-ml-2" />
        ) : (
          <Link href="/" className="font-semibold">
            {t("header.name")}
          </Link>
        )}
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          {user && (
            <>
              <span className="hidden text-sm text-muted-foreground sm:inline">{user.name}</span>
              <SignOutButton />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
