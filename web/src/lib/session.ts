// The API's session cookie (see the API's accounts.py): the site never reads it, only passes it on
export const SESSION_COOKIE = "session";

// Where to go after signing in: the page asked for, if it's one of the site's own, or the home page. An address like
// //evil.example would leave the site.
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
