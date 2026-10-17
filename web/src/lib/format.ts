import type { YouTubeComment } from "@/api/types.gen";

// A whole number with its digits grouped by threes, as each language writes it: a no-break space in Russian and
// Uzbek (193 903 608), a comma in English (193,903,608). Done here rather than by Intl, whose Uzbek data differs
// between Node (193 903 608) and Chrome (193,903,608), so the browser would rewrite what the server rendered.
export function formatCount(value: number, locale: string): string {
  const separator = locale === "en" ? "," : " ";
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

const COMPACT = {
  en: { point: ".", units: ["K", "M", "B"] },
  ru: { point: ",", units: [" тыс.", " млн", " млрд"] },
  uz: { point: ",", units: [" ming", " mln", " mlrd"] },
} as const;

// A count cut to three digits, as lists show it: 55.9K, 1.14M, 194M in English, 55,9 тыс. and 1,14 млн in Russian,
// 55,9 ming and 1,14 mln in Uzbek; below 1,000, the count itself. Telegram's pages round counts the same way. With
// short, to two digits at most, as YouTube writes views: 4.8K, 48K, 1.2M.
export function formatCompact(value: number, locale: string, short = false): string {
  const { point, units } = locale in COMPACT ? COMPACT[locale as keyof typeof COMPACT] : COMPACT.en;
  const whole = Math.trunc(value);
  if (Math.abs(whole) < 1000) return String(whole);
  let [scaled, unit] = [whole / 1000, 0];
  while (Math.abs(scaled) >= 999.5 && unit < units.length - 1) [scaled, unit] = [scaled / 1000, unit + 1];
  const size = Math.abs(scaled);
  const digits = short
    ? scaled.toFixed(size >= 9.95 ? 0 : 1)
    : size >= 99.95
      ? scaled.toFixed(0)
      : scaled.toFixed(size >= 9.995 ? 1 : 2);
  const trimmed = digits.includes(".") ? digits.replace(/0+$/, "").replace(/\.$/, "") : digits;
  return trimmed.replace(".", point) + units[unit];
}

// What a count's words take for their form: the count itself, or for a count cut short (1.2M), one that takes the
// "many" form (1,2 млн просмотров, not просмотра)
export const pluralOf = (value: number) => (value >= 1000 ? 1000 : value);

const TASHKENT = 5 * 60 * 60 * 1000; // milliseconds ahead of UTC: Uzbekistan's time, the same all year
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const twoDigits = (n: number) => String(n).padStart(2, "0");

// A moment as its date and time in Tashkent: 16.10.2026, 14:05 in Russian and Uzbek, 16 Oct 2026, 14:05 in English.
// Done here for the same reason as counts: the browser's Intl writes dates differently from Node's.
export function formatDateTime(iso: string, locale: string): string {
  const moment = new Date(Date.parse(iso) + TASHKENT); // read with the UTC getters: Tashkent's own date and time
  const time = `${twoDigits(moment.getUTCHours())}:${twoDigits(moment.getUTCMinutes())}`;
  const [day, month, year] = [moment.getUTCDate(), moment.getUTCMonth(), moment.getUTCFullYear()];
  return locale === "en"
    ? `${day} ${MONTHS[month]} ${year}, ${time}`
    : `${twoDigits(day)}.${twoDigits(month + 1)}.${year}, ${time}`;
}

const WEEKDAYS = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  ru: ["вс", "пн", "вт", "ср", "чт", "пт", "сб"],
  uz: ["Ya", "Du", "Se", "Cho", "Pa", "Ju", "Sha"],
} as const;
const MONTH_NAMES = {
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  ru: [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ],
  uz: ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"],
} as const;
type Words = keyof typeof WEEKDAYS;
const wordsOf = (locale: string): Words => (locale in WEEKDAYS ? (locale as Words) : "en");
const inTashkent = (iso: string | Date) =>
  new Date((typeof iso === "string" ? Date.parse(iso) : iso.getTime()) + TASHKENT);
const dayOf = (moment: Date) => Math.floor(moment.getTime() / (24 * 60 * 60 * 1000)); // Tashkent's day number

// A moment's time in Tashkent, as a message shows it: 14:05
export function formatClock(iso: string): string {
  const moment = inTashkent(iso);
  return `${twoDigits(moment.getUTCHours())}:${twoDigits(moment.getUTCMinutes())}`;
}

// When a channel last posted, as Telegram's chat list says it: the time today, the weekday within a week, the day and
// month this year (16 Oct, 16.10), and the full date before (16.10.25); the full date too without now (see useNow)
export function formatChatDate(iso: string, now: number | null, locale: string): string {
  const moment = inTashkent(iso);
  if (now === null)
    return `${twoDigits(moment.getUTCDate())}.${twoDigits(moment.getUTCMonth() + 1)}.${String(moment.getUTCFullYear()).slice(2)}`;
  const today = inTashkent(new Date(now));
  const days = dayOf(today) - dayOf(moment);
  if (days <= 0) return formatClock(iso);
  if (days < 7) return WEEKDAYS[wordsOf(locale)][moment.getUTCDay()] ?? "";
  const [day, month, year] = [moment.getUTCDate(), moment.getUTCMonth(), moment.getUTCFullYear()];
  if (year === today.getUTCFullYear()) {
    return locale === "en" ? `${day} ${MONTHS[month]}` : `${twoDigits(day)}.${twoDigits(month + 1)}`;
  }
  return `${twoDigits(day)}.${twoDigits(month + 1)}.${String(year).slice(2)}`;
}

// A day as Telegram heads a day's messages: 16 October, 16 октября, 16-oktabr, with the year when it isn't this one
// (or without now: see useNow)
export function formatDay(iso: string, now: number | null, locale: string): string {
  const moment = inTashkent(iso);
  const [day, month, year] = [moment.getUTCDate(), moment.getUTCMonth(), moment.getUTCFullYear()];
  const name = MONTH_NAMES[wordsOf(locale)][month];
  const said = locale === "uz" ? `${day}-${name}` : `${day} ${name}`;
  return now !== null && year === inTashkent(new Date(now)).getUTCFullYear() ? said : `${said} ${year}`;
}

const SHORT_MONTHS = {
  en: MONTHS,
  ru: ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."],
  uz: ["yan", "fev", "mar", "apr", "may", "iyn", "iyl", "avg", "sen", "okt", "noy", "dek"],
} as const;

// The day a video came out, as YouTube writes it in its open description: Oct 15, 2026, 15 окт. 2026 г., 15-okt, 2026
export function formatYouTubeDate(iso: string, locale: string): string {
  const moment = inTashkent(iso);
  const [day, month, year] = [moment.getUTCDate(), moment.getUTCMonth(), moment.getUTCFullYear()];
  const words = wordsOf(locale);
  const name = SHORT_MONTHS[words][month];
  if (words === "ru") return `${day} ${name} ${year} г.`;
  if (words === "uz") return `${day}-${name}, ${year}`;
  return `${name} ${day}, ${year}`;
}

// The same day in two parts, as YouTube writes it big over the year in a Short's description: 15 окт. over 2026 г.
export function formatYouTubeDay(iso: string, locale: string): [string, string] {
  const moment = inTashkent(iso);
  const [day, month, year] = [moment.getUTCDate(), moment.getUTCMonth(), moment.getUTCFullYear()];
  const words = wordsOf(locale);
  const name = SHORT_MONTHS[words][month];
  if (words === "ru") return [`${day} ${name}`, `${year} г.`];
  if (words === "uz") return [`${day}-${name}`, `${year}`];
  return [`${name} ${day}`, `${year}`];
}

// Whether two moments fall on the same day in Tashkent
export function sameDay(a: string, b: string): boolean {
  return dayOf(inTashkent(a)) === dayOf(inTashkent(b));
}

// A moment's date in Tashkent: 16.10.2026 in Russian and Uzbek, 16 Oct 2026 in English
export function formatDate(iso: string, locale: string): string {
  const moment = new Date(Date.parse(iso) + TASHKENT);
  const [day, month, year] = [moment.getUTCDate(), moment.getUTCMonth(), moment.getUTCFullYear()];
  return locale === "en" ? `${day} ${MONTHS[month]} ${year}` : `${twoDigits(day)}.${twoDigits(month + 1)}.${year}`;
}

// A length in seconds as a clock shows it: 0:15, 12:34, 1:02:03
export function formatDuration(seconds: number): string {
  const [hours, minutes, rest] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return hours ? `${hours}:${twoDigits(minutes)}:${twoDigits(rest)}` : `${minutes}:${twoDigits(rest)}`;
}

// When a comment was written, as precisely as YouTube said it: YouTube says only how long ago ("3 hours ago", "2 months
// ago"), and that was counted back from when the comment was read. So a time to the minute for seconds and minutes;
// ≈ and the hour for hours; ≈ and the day for days and weeks; ≈ and the month, or the year, for those.
export function formatWhen(iso: string, precision: YouTubeComment["precision"], locale: string): string {
  const moment = new Date(Date.parse(iso) + TASHKENT);
  const [day, month, year] = [moment.getUTCDate(), moment.getUTCMonth(), moment.getUTCFullYear()];
  const date =
    locale === "en" ? `${day} ${MONTHS[month]} ${year}` : `${twoDigits(day)}.${twoDigits(month + 1)}.${year}`;
  switch (precision) {
    case "year":
      return `≈${year}`;
    case "month":
      return locale === "en" ? `≈${MONTHS[month]} ${year}` : `≈${twoDigits(month + 1)}.${year}`;
    case "week":
    case "day":
      return `≈${date}`;
    case "hour":
      return `${date}, ≈${twoDigits(moment.getUTCHours())}:00`;
    default:
      return formatDateTime(iso, locale);
  }
}

const UNITS = { en: ["s", "min", "h"], ru: ["с", "мин", "ч"], uz: ["s", "daq", "soat"] } as const;

// A length of time, as it's said: 12 s, 4 min 5 s, 1 h 2 min
export function formatSeconds(seconds: number, locale: string): string {
  const [s, min, h] = locale in UNITS ? UNITS[locale as keyof typeof UNITS] : UNITS.en;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} ${s}`;
  if (whole < 3600) return `${Math.floor(whole / 60)} ${min} ${whole % 60} ${s}`;
  return `${Math.floor(whole / 3600)} ${h} ${Math.floor((whole % 3600) / 60)} ${min}`;
}
