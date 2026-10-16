// The codes the site has a message for (messages/*.json, "errors"): the API's own (see the API's errors.py), and
// "unavailable" for when the API didn't answer at all
export type ErrorCode =
  "unavailable" | "database_unavailable" | "database_timeout" | "not_found" | "invalid_request" | "internal";

const API_CODES: readonly ErrorCode[] = [
  "database_unavailable",
  "database_timeout",
  "not_found",
  "invalid_request",
  "internal",
];

// What a failed request gave back, as a code, and the request's ID if the API gave one. The API answers a failure
// with {"error": code, "message", "request_id"}; anything else (a network error, a timeout, or a page from something in
// between, like Next's plain "Internal Server Error" while the API is down) means the API didn't answer. A code the
// site has no message for counts as internal.
export function apiFailure(error: unknown): { code: ErrorCode; requestId?: string } {
  if (typeof error !== "object" || error === null || !("error" in error) || typeof error.error !== "string") {
    return { code: "unavailable" };
  }
  const given = error.error;
  const requestId = "request_id" in error && typeof error.request_id === "string" ? error.request_id : undefined;
  return { code: API_CODES.find((code) => code === given) ?? "internal", requestId };
}
