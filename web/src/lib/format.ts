// A whole number with its digits grouped by threes, as each language writes it: a no-break space in Russian and
// Uzbek (193 903 608), a comma in English (193,903,608). Done here rather than by Intl, whose Uzbek data differs
// between Node (193 903 608) and Chrome (193,903,608), so the browser would rewrite what the server rendered.
export function formatCount(value: number, locale: string): string {
  const separator = locale === "en" ? "," : " ";
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}
