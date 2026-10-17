import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { Header } from "@/components/header";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { signedInUser } from "@/lib/api-server";

const SIDEBAR_COOKIE = "sidebar_state"; // where shadcn's sidebar keeps whether it's open or folded

// Every page here needs someone signed in: whoever isn't, or whose session ended, goes to the sign-in page, and
// whoever has a temporary password, to the page that changes it. (proxy.ts sends visitors without a session cookie to
// the sign-in page before any of this, and gives the path asked for in x-path.) Admins get their menu at the side,
// open or folded as they last left it, and no bar above the page; on a phone, a thin one opens the menu.
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
  const open = (await cookies()).get(SIDEBAR_COOKIE)?.value !== "false";
  const t = await getTranslations();
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={open}>
        <AppSidebar user={user} />
        <SidebarInset>
          <div className="flex h-12 items-center gap-2 border-b px-3 md:hidden">
            <SidebarTrigger aria-label={t("nav.toggle")} />
            <span className="font-semibold">{t("header.name")}</span>
          </div>
          {/* As wide as the window: each page keeps its own width (YouTube's video page takes the most) */}
          <div className="w-full px-4 py-6 sm:px-8">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
