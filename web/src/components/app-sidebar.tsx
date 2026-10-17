"use client";

import { ActivityIcon, LayoutDashboardIcon, RadarIcon, SendIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ComponentType } from "react";

import type { Me } from "@/api/types.gen";
import { YouTubeIcon } from "@/components/brand-icons";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { UserMenu } from "@/components/user-menu";

// The admins' menu, at the side: the overview, YouTube and Telegram, then, apart at the bottom, the activity, and at
// its foot who's signed in, with the language and signing out. On a wide screen it folds down to its icons (its own
// button, a click on its edge, or Ctrl+B), which then name themselves on hover; on a phone it slides in over the page,
// and goes away once a page is chosen.
export function AppSidebar({ user }: { user: Me }) {
  const t = useTranslations();
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2">
          {/* Folded, only the button shows: it opens the menu again */}
          <Link
            href="/"
            onClick={() => setOpenMobile(false)}
            className="flex min-w-0 flex-1 items-center gap-2 pl-1 group-data-[collapsible=icon]:hidden"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <RadarIcon className="size-3.5" />
            </span>
            <span className="truncate font-semibold text-sidebar-accent-foreground">{t("header.name")}</span>
          </Link>
          <SidebarTrigger aria-label={t("nav.toggle")} className="shrink-0 text-muted-foreground" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <Item href="/" icon={LayoutDashboardIcon} label={t("nav.overview")} />
            <Item href="/youtube/channels" also="/youtube" icon={YouTubeIcon} label="YouTube" />
            <Item href="/telegram/channels" also="/telegram" icon={SendIcon} label="Telegram" />
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="mt-auto">
          <SidebarMenu>
            <Item href="/activity" icon={ActivityIcon} label={t("nav.activity")} />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu name={user.name} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

// A page of the menu, which shows itself as the current one on its own pages and below also (a channel, a video)
function Item({
  href,
  also,
  icon: Icon,
  label,
}: {
  href: string;
  also?: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const active = href === "/" ? pathname === "/" : [href, also].some((path) => path && pathname.startsWith(path));
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<Link href={href} aria-current={active ? "page" : undefined} onClick={() => setOpenMobile(false)} />}
        isActive={active}
        tooltip={label}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
