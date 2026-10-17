"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { SidebarTrigger } from "@/components/ui/sidebar";

// YouTube's and Telegram's pages have their own top bars, with the menu's button (YouTube's ☰ on a phone, Telegram's
// ☰ at the top of its chat list) and the whole window to themselves: no bar above them, and no margins round them
const ownBar = (path: string) => path.startsWith("/youtube") || path.startsWith("/telegram");

// On a phone, the thin bar above the page with the menu's button, but on YouTube's and Telegram's pages
export function PhoneBar({ name, toggle }: { name: string; toggle: string }) {
  const path = usePathname();
  if (ownBar(path)) return null;
  return (
    <div className="flex h-12 items-center gap-2 border-b px-3 md:hidden">
      <SidebarTrigger aria-label={toggle} />
      <span className="font-semibold">{name}</span>
    </div>
  );
}

// The page, as wide as the window (each page keeps its own width), with margins round it but on YouTube's and
// Telegram's pages
export function PageFrame({ children }: { children: ReactNode }) {
  const path = usePathname();
  return <div className={ownBar(path) ? "w-full" : "w-full px-4 py-6 sm:px-8"}>{children}</div>;
}
