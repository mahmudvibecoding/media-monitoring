// The codes the site has a message for (messages/*.json, "errors"): the API's own (see the API's errors.py,
// accounts.py, organizations.py and projects.py), and "unavailable" for when the API didn't answer at all
const API_CODES = [
  "database_unavailable",
  "database_timeout",
  "not_found",
  "invalid_request",
  "internal",
  "wrong_credentials",
  "account_disabled",
  "too_many_attempts",
  "wrong_password",
  "weak_password",
  "not_signed_in",
  "must_change_password",
  "forbidden",
  "cross_site",
  "name_taken",
  "email_taken",
  "invalid_name",
  "invalid_email",
  "project_name_taken",
  "invalid_keyword",
  "no_keywords",
] as const;
export type ErrorCode = "unavailable" | (typeof API_CODES)[number];

// The codes for a request that was wrong, or refused, rather than one that failed: asking again won't help
export const REQUEST_ERRORS: ReadonlySet<string> = new Set([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "invalid_request",
  "wrong_credentials",
  "account_disabled",
  "too_many_attempts",
  "wrong_password",
  "weak_password",
  "not_signed_in",
  "must_change_password",
  "cross_site",
  "name_taken",
  "email_taken",
  "invalid_name",
  "invalid_email",
  "project_name_taken",
  "invalid_keyword",
  "no_keywords",
]);

// What a failed request gave back, as a code, and the request's ID if the API gave one. The API answers a failure
// with {"error": code, "message", "request_id"}; anything else (a network error, a timeout, or a page from something in
// between, like Next's plain "Internal Server Error" while the API is down) means the API didn't answer. A code the
// site has no message for counts as internal.
export function apiFailure(error: unknown): { code: ErrorCode; requestId?: string; given?: string } {
  if (typeof error !== "object" || error === null || !("error" in error) || typeof error.error !== "string") {
    return { code: "unavailable" };
  }
  const given = error.error;
  const requestId = "request_id" in error && typeof error.request_id === "string" ? error.request_id : undefined;
  return { code: API_CODES.find((code) => code === given) ?? "internal", requestId, given };
}
