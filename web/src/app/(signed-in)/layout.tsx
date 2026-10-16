import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { Header } from "@/components/header";
import { signedInUser } from "@/lib/api-server";

// Every page here needs someone signed in: whoever isn't, or whose session ended, goes to the sign-in page, and
// whoever has a temporary password, to the page that changes it. (proxy.ts sends visitors without a session cookie to
// the sign-in page before any of this, and gives the path asked for in x-path.)
export default async function SignedInLayout({ children }: { children: ReactNode }) {
  const user = await signedInUser();
  const path = (await headers()).get("x-path") ?? "/";
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(path)}`);
  if (user.must_change_password && !path.startsWith("/change-password")) {
    redirect(`/change-password?next=${encodeURIComponent(path)}`);
  }
  return (
    <>
      <Header user={user} />
      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </>
  );
}
