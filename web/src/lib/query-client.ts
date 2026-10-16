import { isServer, QueryCache, QueryClient } from "@tanstack/react-query";
import { cache } from "react";

import { apiFailure, REQUEST_ERRORS } from "@/lib/api-error";

// A failed request is asked again twice, unless it was wrong, or refused
function retry(failures: number, error: unknown) {
  const given = apiFailure(error).given;
  return failures < 2 && !(given && REQUEST_ERRORS.has(given));
}

function makeQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      // In the browser, data refused for not being signed in means the session ended while the page was open: sign in
      // again, then come back
      onError: (error) => {
        if (!isServer && apiFailure(error).code === "not_signed_in") {
          // A full load, not Next's router: it drops all that the tab kept of the account
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
        }
      },
    }),
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
