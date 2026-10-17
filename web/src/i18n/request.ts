import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import uz from "../../messages/uz.json";
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "./config";

// Every language has every text (a key missing from ru.json or uz.json fails the typecheck), but for the activity, which
// is only in English (see EnglishOnly): Russian and Uzbek take its texts from English
const messages: Record<Locale, typeof en> = {
  ru: { ...ru, activity: en.activity },
  uz: { ...uz, activity: en.activity },
  en,
};

// For each request: the language the visitor chose, or Russian, and its texts
export default getRequestConfig(async () => {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(chosen) ? chosen : defaultLocale;
  return { locale, messages: messages[locale] };
});
