import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { CSSProperties, ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { Header } from "@/components/header";
import { PageFrame, PhoneBar } from "@/components/page-frame";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { signedInUser } from "@/lib/api-server";

// The menu's width on a wide screen, where it's always folded to its icons, each with its name under it: 72 px, as
// YouTube's narrow menu
const STRIP = { "--sidebar-width-icon": "4.5rem" } as CSSProperties;

// Every page here needs someone signed in: whoever isn't, or whose session ended, goes to the sign-in page, and
// whoever has a temporary password, to the page that changes it. (proxy.ts sends visitors without a session cookie to
// the sign-in page before any of this, and gives the path asked for in x-path.) Admins get their menu at the side, a
// strip of icons, and no bar above the page; on a phone, a thin one opens the menu (YouTube's and Telegram's pages have
// their own, which do).
export default async function SignedInLayout({ children }: { children: ReactNode }) {
  const user = await signedInUser();
  const path = (await headers()).get("x-path") ?? "/";
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(path)}`);
  if (user.must_change_password && !path.startsWith("/change-password")) {
    redirect(`/change-password?next=${encodeURIComponent(path)}`);
  }
  if (user.role !== "admin" || user.must_change_password) {
    return (
      <>
        <Header user={user} />
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </>
    );
  }
  const t = await getTranslations();
  return (
    <TooltipProvider>
      <SidebarProvider open={false} style={STRIP}>
        <AppSidebar user={user} />
        <SidebarInset>
          <PhoneBar name={t("header.name")} toggle={t("nav.toggle")} />
          <PageFrame>{children}</PageFrame>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
