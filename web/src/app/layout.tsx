import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";

import { QueryProvider } from "@/components/query-provider";
import { inter } from "@/lib/fonts";
import { cn } from "@/lib/utils";
import "./globals.css";

// Every page is in the visitor's language, from a cookie, so pages are rendered for each request
export const instant = false;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata");
  return { title: t("title"), description: t("description") };
}

// Every page's frame; the header and the page's width come from (signed-in)/layout.tsx and the sign-in page
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={cn("font-sans", inter.variable)}>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider>
          <QueryProvider>{children}</QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
