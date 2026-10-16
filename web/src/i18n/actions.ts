"use server";

import { cookies } from "next/headers";

import { changeLocale } from "@/api/sdk.gen";
import { serverClient } from "@/lib/api-server";
import { SESSION_COOKIE } from "@/lib/session";

import { isLocale, LOCALE_COOKIE } from "./config";

const YEAR = 60 * 60 * 24 * 365; // seconds

// Keeps the visitor's language for a year, and for someone signed in, in their account too, which the site switches to
// when they sign in, in any browser. Next renders the page again in it right away.
export async function setLocale(locale: string) {
  if (!isLocale(locale)) return;
  const jar = await cookies();
  jar.set(LOCALE_COOKIE, locale, { maxAge: YEAR, path: "/", sameSite: "lax", httpOnly: true });
  if (jar.has(SESSION_COOKIE)) {
    await changeLocale({ client: serverClient, body: { locale } }).catch(() => undefined); // the cookie is enough
  }
}

// Just after signing in: a language this browser chose before stays, and goes into the account; without one, the
// account's language is used here too
export async function adoptLocale(accountLocale: string) {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  await setLocale(isLocale(chosen) ? chosen : accountLocale);
}
