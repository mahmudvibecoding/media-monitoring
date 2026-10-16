import type { CreateClientConfig } from "@/api/client.gen";
import { API_URL } from "@/lib/api-url";

// The generated client builds every request on BASE, the same on the server and in the browser: TanStack Query's keys
// include it, so they match and the browser reuses the data the server loaded for the page. BASE is never contacted:
// fetch below sends each request on, from the server straight to the API, from the browser to the site's own
// /api/..., which reaches the same API (see next.config.ts).
const BASE = "http://api";

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: BASE,
  fetch: async (input, init) => {
    const request = new Request(input, init);
    const { pathname, search } = new URL(request.url);
    const target = typeof window === "undefined" ? API_URL : window.location.origin;
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    return fetch(`${target}${pathname}${search}`, {
      method: request.method,
      headers: request.headers,
      body,
      signal: request.signal,
    });
  },
});
