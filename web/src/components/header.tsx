import { getTranslations } from "next-intl/server";

import type { Me } from "@/api/types.gen";
import { LanguageSwitcher } from "@/components/language-switcher";
import { PageLink } from "@/components/page-link";
import { SignOutButton } from "@/components/sign-out-button";

// The top of the pages without the admins' menu (the sign-in page, customers' pages): the site's name, the language
// menu, and, once someone's signed in, their name and signing out. Admins have all this in their menu instead.
export async function Header({ user }: { user?: Me }) {
  const t = await getTranslations();
  return (
    <header className="border-b">
      <div className="mx-auto flex h-12 max-w-7xl items-center justify-between gap-4 px-4 sm:px-8">
        <PageLink href="/" className="font-semibold">
          {t("header.name")}
        </PageLink>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          {user && (
            <>
              <span className="hidden text-muted-foreground sm:inline">{user.name}</span>
              <SignOutButton />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
