import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import uz from "../../messages/uz.json";
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "./config";

// Every language has every text: a key missing from uz.json or en.json fails the typecheck
const messages: Record<Locale, typeof ru> = { ru, uz, en };

// For each request: the language the visitor chose, or Russian, and its texts
export default getRequestConfig(async () => {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = isLocale(chosen) ? chosen : defaultLocale;
  return { locale, messages: messages[locale] };
});
