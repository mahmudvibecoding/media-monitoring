import Link from "next/link";
import { getTranslations } from "next-intl/server";

import type { Me } from "@/api/types.gen";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SignOutButton } from "@/components/sign-out-button";

// The top of every page: the site's name, the language menu, and, once someone's signed in, their name and signing out
export async function Header({ user }: { user?: Me }) {
  const t = await getTranslations("header");
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-6">
        <Link href="/" className="font-semibold">
          {t("name")}
        </Link>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          {user && (
            <>
              <span className="text-sm text-muted-foreground">{user.name}</span>
              <SignOutButton />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
