"use client";

import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { TelegramList } from "@/components/telegram-list";
import { chatIdOf, type Platform } from "@/lib/telegram";
import { cn } from "@/lib/utils";

type Shared = {
  info: boolean; // whether a channel's info is open beside its chat: it stays open from one chat to the next
  setInfo: (open: boolean) => void;
  toast: (text: string) => void; // a short note at the top of the window, as Telegram's "Link copied to clipboard"
};
const TelegramContext = createContext<Shared>({ info: false, setInfo: () => {}, toast: () => {} });

export const useTelegram = () => useContext(TelegramContext);

const TOAST_FOR = 3000; // ms

// Telegram's pages, laid out as Telegram Web: its wallpaper over the whole window, the chat list in a floating panel
// at the left, and the chat open (or nothing, at first) in the rest, as wide as Telegram makes them for the room there
// is (a container: the site's menu takes some). Below 926 px, a chat takes all the room and the list hides while it's
// open; below 601 px, the list takes the whole screen too, without its panel's margins. Nothing here scrolls but the
// lists inside (overflow: clip, which even focusing something can't scroll).
export function TelegramFrame({ platform, children }: { platform: Platform; children: ReactNode }) {
  const open = chatIdOf(usePathname()) !== null;
  const [info, setInfo] = useState(false);
  const [note, setNote] = useState<{ text: string; at: number } | null>(null);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), TOAST_FOR);
    return () => clearTimeout(timer);
  }, [note]);
  return (
    <TelegramContext value={{ info, setInfo, toast: (text) => setNote({ text, at: Date.now() }) }}>
      <div
        data-platform={platform}
        className="telegram @container/telegram relative flex h-svh overflow-clip text-base leading-normal text-tg-text [--tg-right:max(26.5rem,25cqw)] tg-wallpaper"
      >
        <aside
          className={cn(
            "relative z-10 flex min-h-0 w-full shrink-0 flex-col overflow-clip bg-white",
            "@min-[601px]/telegram:my-4 @min-[601px]/telegram:ml-4 @min-[601px]/telegram:w-[26.5rem] @min-[601px]/telegram:tg-island @min-[601px]/telegram:shadow-tg-island",
            "@min-[926px]/telegram:w-[max(16rem,33cqw)] @min-[926px]/telegram:max-w-[40cqw]",
            "@min-[1276px]/telegram:w-[max(16rem,25cqw)] @min-[1276px]/telegram:max-w-[33cqw]",
            open && "@max-[926px]/telegram:hidden",
          )}
        >
          <TelegramList />
        </aside>
        <main className={cn("relative min-w-0 flex-1", !open && "@max-[601px]/telegram:hidden")}>{children}</main>
        {note && (
          <div
            key={note.at}
            role="status"
            className="pointer-events-none absolute top-4 left-1/2 z-50 max-w-[calc(100%-2rem)] -translate-x-1/2 animate-in rounded-[1rem] bg-[#202020cc] px-4 py-2.5 text-[15px] leading-5 text-white backdrop-blur-sm fade-in slide-in-from-top-2"
          >
            {note.text}
          </div>
        )}
      </div>
    </TelegramContext>
  );
}
