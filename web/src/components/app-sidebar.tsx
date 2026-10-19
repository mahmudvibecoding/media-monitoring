"use client";

import { ActivityIcon, RadarIcon, SendIcon } from "lucide-react";
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
  useSidebar,
} from "@/components/ui/sidebar";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";

// On a wide screen, the menu is a narrow strip, as YouTube's narrow menu: each item a square, its icon with its name
// under it (shadcn's sidebar, folded to its icons, the whole time: the layout keeps it so)
const STRIP_ITEM = cn(
  "group-data-[collapsible=icon]:size-auto! group-data-[collapsible=icon]:w-full! group-data-[collapsible=icon]:aspect-square",
  "group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-1.5",
  "group-data-[collapsible=icon]:rounded-xl group-data-[collapsible=icon]:p-0.5!",
  "group-data-[collapsible=icon]:text-center group-data-[collapsible=icon]:text-[11px]",
  "group-data-[collapsible=icon]:leading-3.5 group-data-[collapsible=icon]:[&_svg]:size-6",
  "group-data-[collapsible=icon]:[&>span]:line-clamp-2 group-data-[collapsible=icon]:[&>span]:whitespace-normal!",
  // Under the mouse, a lighter gray than the current page's, so that the two don't look both chosen
  "group-data-[collapsible=icon]:hover:not-data-active:bg-sidebar-accent/50",
);
const STRIP_SIDES = "group-data-[collapsible=icon]:px-1"; // 4 px from its sides, so that its items are 70 px squares
const STRIP_GAPS = "group-data-[collapsible=icon]:gap-1"; // and apart, each a tile of its own

// The admins' menu, at the side: the activity (with how much the database holds; a run's page too), YouTube and
// Telegram, and at its foot who's signed in, with the language and signing out. On a wide screen it's a strip 79 px
// wide, always there, as YouTube's narrow menu; on a phone it slides in over the page, with the site's name at its top,
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
      <SidebarHeader className="group-data-[collapsible=icon]:hidden">
        <PageLink href="/" onClick={() => choose("/")} className="flex h-8 min-w-0 items-center gap-2 pl-1">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <RadarIcon className="size-3.5" />
          </span>
          <span className="truncate font-semibold text-sidebar-accent-foreground">{t("header.name")}</span>
        </PageLink>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className={STRIP_SIDES}>
          <SidebarMenu className={STRIP_GAPS}>
            <Item href="/" also="/activity" icon={ActivityIcon} label={t("nav.activity")} {...item} />
            <Item href="/youtube/channels" also="/youtube" icon={YouTubeIcon} label="YouTube" {...item} />
            <Item href="/telegram/channels" also="/telegram" icon={SendIcon} label="Telegram" {...item} />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className={STRIP_SIDES}>
        <UserMenu name={user.name} className={STRIP_ITEM} />
      </SidebarFooter>
    </Sidebar>
  );
}

// A page of the menu, which shows itself as the current one on its own pages and on those under also (a YouTube
// video, a run's page), or, once an item is clicked, while its page is on its way (chosen)
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
  const here = (href === "/" ? pathname === "/" : pathname.startsWith(href)) || (!!also && pathname.startsWith(also));
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
        className={STRIP_ITEM}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
