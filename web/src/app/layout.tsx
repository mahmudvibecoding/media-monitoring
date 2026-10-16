import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";

import { Header } from "@/components/header";
import { QueryProvider } from "@/components/query-provider";
import { cn } from "@/lib/utils";
import "./globals.css";

// Every page is in the visitor's language, from a cookie, so pages are rendered for each request
export const instant = false;

// Inter has every letter the three languages use, Uzbek's ʻ (oʻ, gʻ) and Cyrillic Ў, Қ, Ғ, Ҳ included. Next serves it
// from this server; its Latin and Cyrillic letters load with the page, the rest when a page uses them.
const inter = Inter({ subsets: ["latin", "cyrillic"], variable: "--font-sans" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata");
  return { title: t("title"), description: t("description") };
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={cn("font-sans", inter.variable)}>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider>
          <QueryProvider>
            <Header />
            <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
          </QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
