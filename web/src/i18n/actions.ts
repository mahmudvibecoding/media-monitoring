"use server";

import { cookies } from "next/headers";

import { isLocale, LOCALE_COOKIE } from "./config";

const YEAR = 60 * 60 * 24 * 365; // seconds

// Keeps the visitor's language for a year; Next renders the page again in it right away
export async function setLocale(locale: string) {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { maxAge: YEAR, path: "/", sameSite: "lax", httpOnly: true });
}
