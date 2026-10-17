"use client";

import { ActivityIcon, LayoutDashboardIcon, type LucideIcon, RadarIcon, SendIcon, TvIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

// The admins' menu, at the side: the overview, then each kind of collected data. On a wide screen it folds down to
// its icons (the header's button, or Ctrl+B), which then name themselves on hover; on a phone it slides in over the
// page, and goes away once a page is chosen.
export function AppSidebar() {
  const t = useTranslations();
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/" onClick={() => setOpenMobile(false)} />}
              tooltip={t("header.name")}
            >
              {/* As wide as the folded menu, so that it alone shows then */}
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <RadarIcon />
              </span>
              <span className="font-semibold">{t("header.name")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <Item href="/" icon={LayoutDashboardIcon} label={t("nav.overview")} />
            <Item href="/activity" icon={ActivityIcon} label={t("nav.activity")} />
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>YouTube</SidebarGroupLabel>
          <SidebarMenu>
            <Item href="/youtube/channels" also="/youtube/videos" icon={TvIcon} label={t("nav.channels")} />
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Telegram</SidebarGroupLabel>
          <SidebarMenu>
            <Item href="/telegram/channels" icon={SendIcon} label={t("nav.channels")} />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

// A page of the menu, which shows itself as the current one on its own pages and on also's (a channel's video)
function Item({ href, also, icon: Icon, label }: { href: string; also?: string; icon: LucideIcon; label: string }) {
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
