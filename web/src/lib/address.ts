// The part of a page's address after its path, from values, leaving out the undefined ones: "" when none are left
export function addressOf(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const address = params.toString();
  return address ? `?${address}` : "";
}

// A new address for a list on the page, without asking the server: Next follows it (useSearchParams), and the list
// loads what it asks for. A new page or order is a step that Back undoes; each key typed into a search isn't.
export function go(address: string, step: "push" | "replace") {
  const to = address || window.location.pathname;
  if (step === "push") window.history.pushState(null, "", to);
  else window.history.replaceState(null, "", to);
}

// A page's searchParams, as Next gives them to it on the server, the way the browser reads them: a name given more
// than once counts with its first value
export function toSearchParams(given: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(given)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(name, first);
  }
  return params;
}
