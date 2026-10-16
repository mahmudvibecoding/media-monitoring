import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { createClient, createConfig } from "@/api/client";
import { me } from "@/api/sdk.gen";
import type { Me } from "@/api/types.gen";
import { BASE, send } from "@/lib/api-client";
import { SESSION_COOKIE } from "@/lib/session";

// The API's client for the site's server, which passes the visitor's session cookie on, so the API knows who's asking.
// Give it to the generated functions as { client: serverClient }: their TanStack Query keys stay the browser's.
export const serverClient = createClient(
  createConfig({
    baseUrl: BASE,
    fetch: async (input, init) => {
      const session = (await cookies()).get(SESSION_COOKIE)?.value;
      return send(new Request(input, init), session ? { cookie: `${SESSION_COOKIE}=${session}` } : undefined);
    },
  }),
);

// Who's signed in, or null if no one is (or their session ended); asked once per page, however many parts ask.
// Other failures, like the API being down, are thrown, for the page's error page.
export const signedInUser = cache(async (): Promise<Me | null> => {
  if (!(await cookies()).has(SESSION_COOKIE)) return null;
  const { data, error, response } = await me({ client: serverClient });
  if (data) return data;
  if (response?.status === 401) return null;
  throw new Error(`the API didn't say who's signed in: ${JSON.stringify(error)}`);
});
