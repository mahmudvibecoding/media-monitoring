import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";

import en from "../../messages/en.json";

// What's inside is in English, whatever language the visitor chose: the activity, which only those who run the system
// read. Its texts, numbers, dates and times ("3 min ago") are English, from the English texts it uses.
export function EnglishOnly({ children }: { children: ReactNode }) {
  const { activity, time, common, pages, errors } = en;
  return (
    <NextIntlClientProvider locale="en" messages={{ activity, time, common, pages, errors }}>
      {children}
    </NextIntlClientProvider>
  );
}
