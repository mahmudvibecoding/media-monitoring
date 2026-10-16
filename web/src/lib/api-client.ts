import type { CreateClientConfig } from "@/api/client.gen";
import { API_URL } from "@/lib/api-url";

// The generated client builds every request on BASE, the same on the server and in the browser: TanStack Query's keys
// include it, so they match and the browser reuses the data the server loaded for the page. BASE is never contacted:
// send() sends each request on, from the server straight to the API, from the browser to the site's own /api/...,
// which reaches the same API (see next.config.ts).
export const BASE = "http://api";
// How long a request may take before it counts as unanswered: a page rendered on the server doesn't wait long (the
// browser asks again itself); the browser waits longer than the API's own limits (5 s for a database connection, 5 s
// for a query)
const SERVER_WAIT = 3_000; // milliseconds
const BROWSER_WAIT = 15_000;

export async function send(request: Request, headers?: Record<string, string>): Promise<Response> {
  const { pathname, search } = new URL(request.url);
  const onServer = typeof window === "undefined";
  const target = onServer ? API_URL : window.location.origin;
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const sent = new Headers(request.headers);
  for (const [name, value] of Object.entries(headers ?? {})) sent.set(name, value);
  return fetch(`${target}${pathname}${search}`, {
    method: request.method,
    headers: sent,
    body,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(onServer ? SERVER_WAIT : BROWSER_WAIT)]),
  });
}

// The browser's client (in the browser, the session cookie goes along by itself); the site's server has its own, in
// api-server.ts
export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: BASE,
  fetch: (input, init) => send(new Request(input, init)),
});
