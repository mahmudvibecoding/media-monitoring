"use client";

import { ActivityIcon, RadarIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ComponentType, type SVGProps, useState } from "react";

import type { Me } from "@/api/types.gen";
import { TelegramLogo, YouTubeMark } from "@/components/brand-icons";
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

// The admins' menu, at the side: the activity (with how much the database holds; a run's page too), YouTube, Telegram
// and the users (the customers' organizations and their people), and at its foot who's signed in, with the language and
// signing out. On a wide screen it's a strip 79 px wide, always there, as YouTube's narrow menu; on a phone it slides
// in over the page, with the site's name at its top, and goes away once a page is chosen. The item clicked shows as the
// current one at once, while its page is on its way.
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
            <Item href="/" also="/activity" icon={ActivityMark} label={t("nav.activity")} {...item} />
            <Item href="/youtube/channels" also="/youtube" icon={YouTubeMark} label="YouTube" {...item} />
            <Item href="/telegram/channels" also="/telegram" icon={TelegramLogo} label="Telegram" {...item} />
            <Item href="/users" icon={UsersMark} label={t("nav.users")} {...item} />
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className={STRIP_SIDES}>
        <UserMenu name={user.name} className={STRIP_ITEM} />
      </SidebarFooter>
    </Sidebar>
  );
}

// The menu's icons: YouTube's and Telegram's own marks in their colors, the activity's pulse in light blue, and the
// users (Material Symbols' "group", filled) in the names' near-black
function ActivityMark({ className }: { className?: string }) {
  return <ActivityIcon className={cn("text-[#0ea5e9]", className)} />;
}

function UsersMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M40-160v-112q0-34 17.5-62.5T104-378q62-31 126-46.5T360-440q66 0 130 15.5T616-378q29 15 46.5 43.5T680-272v112H40Zm720 0v-120q0-44-24.5-84.5T666-434q51 6 96 20.5t84 35.5q36 20 55 44.5t19 53.5v120H760ZM247-527q-47-47-47-113t47-113q47-47 113-47t113 47q47 47 47 113t-47 113q-47 47-113 47t-113-47Zm466 0q-47 47-113 47-11 0-28-2.5t-28-5.5q27-32 41.5-71t14.5-81q0-42-14.5-81T544-792q14-5 28-6.5t28-1.5q66 0 113 47t47 113q0 66-47 113Z" />
    </svg>
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
