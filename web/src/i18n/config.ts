// The site's languages: Russian by default, Uzbek (in Latin script) and English. A visitor's choice is kept in a
// cookie (see actions.ts) and read for each request (see request.ts).
export const locales = ["ru", "uz", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "ru";
export const LOCALE_COOKIE = "NEXT_LOCALE";

// Each language's name in itself, as the language menu shows it
export const localeNames: Record<Locale, string> = { ru: "Русский", uz: "Oʻzbekcha", en: "English" };

export function isLocale(value: unknown): value is Locale {
  return locales.includes(value as Locale);
}
