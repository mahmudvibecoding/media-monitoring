import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { LanguageSwitcher } from "@/components/language-switcher";

export async function Header() {
  const t = await getTranslations("header");
  return (
    <header className="border-b">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="font-semibold">
          {t("name")}
        </Link>
        <LanguageSwitcher />
      </div>
    </header>
  );
}
