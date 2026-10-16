"use client";

import { inter } from "@/lib/fonts";
import { cn } from "@/lib/utils";

import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import uz from "../../messages/uz.json";
import "./globals.css";

const languages = [
  ["ru", ru.globalError],
  ["uz", uz.globalError],
  ["en", en.globalError],
] as const;

// When even the frame failed (the root layout), the visitor's language isn't known, so this page says it in all three.
// It replaces the whole page, and the button loads it again.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="ru" className={cn("font-sans", inter.variable)}>
      <body className="flex min-h-screen items-center justify-center p-6">
        <div role="alert" className="max-w-md space-y-4 text-center">
          {languages.map(([lang, texts]) => (
            <p key={lang} lang={lang}>
              {texts.message}
            </p>
          ))}
          {error.digest && <p className="text-sm text-muted-foreground">{error.digest}</p>}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-muted"
          >
            {languages.map(([, texts]) => texts.retry).join(" · ")}
          </button>
        </div>
      </body>
    </html>
  );
}
