"use client";

import { useLocale, useTranslations } from "next-intl";

import { formatDate, formatDateTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// When something happened, said the short way: just now, 12 min ago, 3 h ago, 5 d ago, and after a week its date; or,
// with youtube, YouTube's way, always as how long ago: 3 days ago, 2 weeks ago, 4 months ago (as under a comment), or
// with youtube="short", as YouTube's lists say it: 3d ago, 2w ago, 4mo ago (3 дн. назад, 2 нед. назад). The exact date
// and time, Tashkent's, shows on hover, and it moves on by itself every minute. It's counted in the browser (see
// useNow): the server writes the date, which the browser turns into how long ago. A title of its own replaces the exact
// time on hover (a comment's time is only as exact as YouTube said it).
export function When({
  iso,
  youtube = false,
  title,
  className,
}: {
  iso: string;
  youtube?: boolean | "short";
  title?: string;
  className?: string;
}) {
  const t = useTranslations("time");
  const locale = useLocale();
  const now = useNow();
  const ago = Math.max(0, (now ?? 0) - Date.parse(iso));
  let said;
  if (now === null) {
    said = formatDate(iso, locale);
  } else if (youtube) {
    const [unit, count] =
      ago < HOUR
        ? (["minutes", Math.floor(ago / MINUTE)] as const)
        : ago < DAY
          ? (["hours", Math.floor(ago / HOUR)] as const)
          : ago < 7 * DAY
            ? (["days", Math.floor(ago / DAY)] as const)
            : ago < 30 * DAY
              ? (["weeks", Math.floor(ago / (7 * DAY))] as const)
              : ago < 365 * DAY
                ? (["months", Math.floor(ago / (30 * DAY))] as const)
                : (["years", Math.floor(ago / (365 * DAY))] as const);
    said = ago < MINUTE ? t("justNow") : t(`${youtube === "short" ? "youtubeShort" : "youtube"}.${unit}`, { count });
  } else if (ago < MINUTE) {
    said = t("justNow");
  } else if (ago < HOUR) {
    said = t("minutesAgo", { count: Math.floor(ago / MINUTE) });
  } else if (ago < DAY) {
    said = t("hoursAgo", { count: Math.floor(ago / HOUR) });
  } else if (ago < 7 * DAY) {
    said = t("daysAgo", { count: Math.floor(ago / DAY) });
  } else {
    said = formatDate(iso, locale);
  }
  return (
    <time dateTime={iso} title={title ?? formatDateTime(iso, locale)} className={className}>
      {said}
    </time>
  );
}
