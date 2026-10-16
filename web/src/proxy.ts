import { type NextRequest, NextResponse } from "next/server";

import { API_URL } from "@/lib/api-url";
import { safeNext, SESSION_COOKIE } from "@/lib/session";

type Session = { must_change_password: boolean } | null; // null: no one is signed in

// Who's signed in, as the API says: null when no one is (no cookie, or its session ended), undefined when the API
// didn't answer (the page then finds out itself, and shows its error page)
async function session(request: NextRequest): Promise<Session | undefined> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const answer = await fetch(`${API_URL}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (answer.status === 401) return null;
    return answer.ok ? ((await answer.json()) as Session) : undefined;
  } catch {
    return undefined;
  }
}

function go(request: NextRequest, to: string) {
  return NextResponse.redirect(new URL(to, request.nextUrl)); // a full address: Next refuses a path alone here
}

// Before a page loads, so the answer is a plain redirect rather than one inside a page Next has begun sending: whoever
// isn't signed in goes to /sign-in, which sends them back afterwards; whoever has a temporary password, to
// /change-password; whoever is signed in already, from /sign-in on. Only page loads (GET) are redirected: a page's
// actions (POST) go through, and the API decides what they may do. Pages get the path asked for in x-path, for the
// same checks in (signed-in)/layout.tsx.
export async function proxy(request: NextRequest) {
  const { pathname, search, searchParams } = request.nextUrl;
  const path = pathname + search;
  const headers = new Headers(request.headers);
  headers.set("x-path", path);
  if (request.method !== "GET" && request.method !== "HEAD") return NextResponse.next({ request: { headers } });
  const user = await session(request);
  if (pathname === "/sign-in") {
    if (!user) return NextResponse.next();
    const next = safeNext(searchParams.get("next"));
    return go(request, user.must_change_password ? `/change-password?next=${encodeURIComponent(next)}` : next);
  }
  if (user === null) return go(request, `/sign-in?next=${encodeURIComponent(path)}`);
  if (user?.must_change_password && pathname !== "/change-password") {
    return go(request, `/change-password?next=${encodeURIComponent(path)}`);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Every page: not the API (which Caddy sends elsewhere anyway), or Next's own files
  matcher: ["/((?!api/|_next/|favicon.ico).*)"],
};
