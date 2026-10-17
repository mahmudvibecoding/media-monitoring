// A whole number with its digits grouped by threes, as each language writes it: a no-break space in Russian and
// Uzbek (193 903 608), a comma in English (193,903,608). Done here rather than by Intl, whose Uzbek data differs
// between Node (193 903 608) and Chrome (193,903,608), so the browser would rewrite what the server rendered.
export function formatCount(value: number, locale: string): string {
  const separator = locale === "en" ? "," : " ";
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

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

// A length in seconds as a clock shows it: 0:15, 12:34, 1:02:03
export function formatDuration(seconds: number): string {
  const [hours, minutes, rest] = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
  return hours ? `${hours}:${twoDigits(minutes)}:${twoDigits(rest)}` : `${minutes}:${twoDigits(rest)}`;
}
