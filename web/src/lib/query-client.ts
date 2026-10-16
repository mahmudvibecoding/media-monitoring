import { isServer, QueryClient } from "@tanstack/react-query";
import { cache } from "react";

// The API's error codes (see the API's errors.py) for a request that was wrong rather than one that failed: asking again
// won't help
const REQUEST_ERRORS = new Set([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "invalid_request",
]);

// A failed request is asked again twice, unless it was wrong
function retry(failures: number, error: unknown) {
  const code = typeof error === "object" && error !== null && "error" in error ? error.error : undefined;
  return failures < 2 && !(typeof code === "string" && REQUEST_ERRORS.has(code));
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000, // milliseconds: what the server loaded for the page isn't asked for again right away
        // While rendering a page, the server doesn't ask again: the page would wait, and the browser asks again itself
        retry: isServer ? false : retry,
      },
    },
  });
}

// On the server, a new client for each request, shared within it; in the browser, one for as long as the tab is open
const requestQueryClient = cache(makeQueryClient);
let browserQueryClient: QueryClient | undefined;

export function getQueryClient() {
  if (isServer) return requestQueryClient();
  return (browserQueryClient ??= makeQueryClient());
}
