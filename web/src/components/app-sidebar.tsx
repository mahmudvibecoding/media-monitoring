"use client";

import { ActivityIcon, LayoutDashboardIcon, RadarIcon, SendIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ComponentType, useState } from "react";

import type { Me } from "@/api/types.gen";
import { YouTubeIcon } from "@/components/brand-icons";
import { lineFor, PageLink } from "@/components/page-link";
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
// and goes away once a page is chosen. The item clicked shows as the current one at once, while its page is on its way.
export function AppSidebar({ user }: { user: Me }) {
  const t = useTranslations();
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  // The item clicked last, and the page it was clicked on: it's the current one until that page changes
  const [clicked, setClicked] = useState<{ href: string; on: string } | null>(null);
  const chosen = clicked?.on === pathname ? clicked.href : null;
  const choose = (href: string) => {
    setClicked({ href, on: pathname });
    setOpenMobile(false);
  };
  const item = { chosen, choose };
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2">
          {/* Folded, only the button shows: it opens the menu again */}
          <PageLink
            href="/"
            onClick={() => choose("/")}
            className="flex min-w-0 flex-1 items-center gap-2 pl-1 group-data-[collapsible=icon]:hidden"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <RadarIcon className="size-3.5" />
            </span>
            <span className="truncate font-semibold text-sidebar-accent-foreground">{t("header.name")}</span>
          </PageLink>
          <SidebarTrigger aria-label={t("nav.toggle")} className="shrink-0 text-muted-foreground" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <Item href="/" icon={LayoutDashboardIcon} label={t("nav.overview")} {...item} />
            <Item href="/youtube/channels" also="/youtube" icon={YouTubeIcon} label="YouTube" {...item} />
            <Item href="/telegram/channels" also="/telegram" icon={SendIcon} label="Telegram" {...item} />
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="mt-auto">
          <SidebarMenu>
            <Item href="/activity" icon={ActivityIcon} label={t("nav.activity")} {...item} />
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

// A page of the menu, which shows itself as the current one on its own pages and below also (a channel, a video),
// or, once an item is clicked, while its page is on its way (chosen)
function Item({
  href,
  also,
  icon: Icon,
  label,
  chosen,
  choose,
}: {
  href: string;
  also?: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  chosen: string | null;
  choose: (href: string) => void;
}) {
  const pathname = usePathname();
  const here = href === "/" ? pathname === "/" : [href, also].some((path) => path && pathname.startsWith(path));
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={
          <PageLink
            href={href}
            line={lineFor(href)}
            aria-current={here ? "page" : undefined}
            onClick={() => choose(href)}
          />
        }
        isActive={chosen ? chosen === href : here}
        tooltip={label}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
