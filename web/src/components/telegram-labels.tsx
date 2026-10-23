"use client";

import { type InfiniteData, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type RefObject, useEffect, useRef, useState } from "react";

import {
  checkMessageMutation,
  labelMessageMutation,
  telegramChannelMessagesInfiniteQueryKey,
} from "@/api/@tanstack/react-query.gen";
import type { TelegramChannelMessagesData, TelegramMessage, TelegramMessages, TelegramName } from "@/api/types.gen";
import { useTelegram } from "@/components/telegram-frame";
import { NAME_KINDS } from "@/components/telegram-ui";
import { cn } from "@/lib/utils";

// Correcting the names labelled by hand in a chat's messages, as admins do: a selection of a message's text is
// labelled a person, an organization, a place or an event from the toolbar that comes up under it (or with 1 to 4), and a name
// clicked gets another kind, or is removed (Delete). Each change is saved at once, and shows before it's saved; Ctrl+Z
// takes the last ones back, one at a time. A message whose names are right is marked checked, so that what's left to
// check shows in the chat list, and where to go on from.

type Kind = TelegramName["kind"];
type Query = TelegramChannelMessagesData["query"];
// What's picked: a selection of a message's text (index null) or one of its names (its index), where it is in the
// text, in UTF-16 units, and where the toolbar goes, in the chat's column
type Picked = { message: number; start: number; end: number; index: number | null; top: number; left: number };
export type Pick = (message: TelegramMessage, start: number, end: number, index: number | null, rect: DOMRect) => void;

const KEYS: Record<string, Kind> = { "1": "person", "2": "organization", "3": "location", "4": "event" };
const DOTS = {
  person: "bg-tg-person",
  organization: "bg-tg-organization",
  location: "bg-tg-location",
  event: "bg-tg-event",
};
const WORD = /[\p{L}\p{N}\p{M}'ʻʼ‘’`´]/u; // what words are made of: letters, digits, Uzbek's apostrophes
const EDGE = /[\s.,;:!?()[\]{}'ʻʼ‘’`´—–-]/u; // what's left off a name's ends
const QUOTES: Record<string, string> = { "«": "»", '"': '"', "“": "”", "„": "“" };
const TOOLBAR_HEIGHT = 44; // px, about: above the selection when there's no room under it
const TOOLBAR_HALF = 260; // px, about half its width with its Remove: it's kept that far from the column's sides

// A selection made a name: out to whole words (a name takes its endings: Toshkentda), without spaces and punctuation at
// its ends, nor quote marks around the whole of it («Artel» → Artel)
export function snapName(text: string, start: number, end: number): [number, number] {
  while (start > 0 && start < text.length && WORD.test(text[start - 1]!) && WORD.test(text[start]!)) start--;
  while (end > 0 && end < text.length && WORD.test(text[end - 1]!) && WORD.test(text[end]!)) end++;
  while (start < end && EDGE.test(text[start]!)) start++;
  while (end > start && EDGE.test(text[end - 1]!)) end--;
  const close = QUOTES[text[start]!];
  if (close && end - start > 2 && text[end - 1] === close) return [start + 1, end - 1];
  return [start, end];
}

// The editing of a chat's names, while on: what's picked, the toolbar to label it with, and how messages pick (see
// Bubble). column is the chat's scroller, whose parent the toolbar is placed in.
export function useLabelEditing({
  id,
  query,
  column,
  on,
}: {
  id: number;
  query: Query;
  column: RefObject<HTMLDivElement | null>;
  on: boolean;
}) {
  const t = useTranslations("telegramChannel");
  const { toast } = useTelegram();
  const queryClient = useQueryClient();
  const save = useMutation(labelMessageMutation());
  const mark = useMutation(checkMessageMutation());
  const [picked, setPicked] = useState<Picked | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const undo = useRef<{ message: number; names: TelegramName[] }[]>([]);
  const key = telegramChannelMessagesInfiniteQueryKey({ path: { channel_id: id }, query });

  const message = (messageId: number) =>
    queryClient
      .getQueryData<InfiniteData<TelegramMessages>>(key)
      ?.pages.flatMap((page) => page.messages)
      .find((m) => m.id === messageId);

  function change(messageId: number, changed: Partial<TelegramMessage>) {
    queryClient.setQueryData<InfiniteData<TelegramMessages>>(key, (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              messages: page.messages.map((m) => (m.id === messageId ? { ...m, ...changed } : m)),
            })),
          }
        : data,
    );
  }
  const show = (messageId: number, names: TelegramName[]) => change(messageId, { names });

  // Marks a message checked, or not any more: at once, then saved; the chat list's counts and the progress are read
  // again
  function check(m: TelegramMessage) {
    const before = m.checked_at ?? null;
    change(m.id, { checked_at: before ? null : new Date().toISOString() });
    mark.mutate(
      { path: { channel_id: id, message_id: m.id }, body: { checked: !before } },
      {
        onSuccess: (saved) => {
          change(m.id, { checked_at: saved.checked_at });
          void queryClient.invalidateQueries({ queryKey: [{ _id: "telegramChannels" }] });
          void queryClient.invalidateQueries({ queryKey: [{ _id: "labelledProgress" }] });
        },
        onError: () => {
          change(m.id, { checked_at: before });
          toast(t("notSaved"));
        },
      },
    );
  }

  // Shows a message's names at once and saves them; the chat's other views (all its messages, a model's) are read
  // again when next shown
  function put(messageId: number, names: TelegramName[], remember = true) {
    const before = message(messageId)?.names ?? [];
    if (remember) undo.current.push({ message: messageId, names: before });
    show(messageId, names);
    save.mutate(
      {
        path: { channel_id: id, message_id: messageId },
        body: { names: names.map(({ kind, start, end }) => ({ kind, start: start!, end: end! })) },
      },
      {
        onSuccess: (saved) => {
          show(messageId, saved);
          void queryClient.invalidateQueries({
            queryKey: [{ _id: "telegramChannelMessages", path: { channel_id: id } }],
            refetchType: "none",
          });
        },
        onError: () => {
          show(messageId, before);
          toast(t("notSaved"));
        },
      },
    );
  }

  // A kind for what's picked, or, with null, its removal
  function apply(kind: Kind | null) {
    if (!picked) return;
    const found = message(picked.message);
    setPicked(null);
    window.getSelection()?.removeAllRanges();
    if (!found) return;
    const names = found.names ?? [];
    const { start, end, index } = picked;
    if (index !== null) {
      put(
        found.id,
        kind ? names.map((n, i) => (i === index ? { ...n, kind } : n)) : names.filter((_, i) => i !== index),
      );
    } else if (kind) {
      // A new name takes the place of those it overlaps
      const kept = names.filter((n) => n.start === null || n.end === null || n.end <= start || n.start >= end);
      const added = { name: found.text.slice(start, end), kind, start, end };
      put(
        found.id,
        [...kept, added].sort((a, b) => (a.start ?? 0) - (b.start ?? 0)),
      );
    }
  }

  const pick: Pick = (m, start, end, index, rect) => {
    const box = column.current?.parentElement?.getBoundingClientRect();
    if (!on || !box) return;
    const under = rect.bottom - box.top + 6;
    const top = under + TOOLBAR_HEIGHT > box.height ? rect.top - box.top - TOOLBAR_HEIGHT - 6 : under;
    const middle = rect.left + rect.width / 2 - box.left;
    const half = Math.min(TOOLBAR_HALF, box.width / 2);
    const left = Math.min(Math.max(middle, half), box.width - half);
    setPicked({ message: m.id, start, end, index, top, left });
  };

  // Keys, before the chat's own (capture): 1 to 4, Delete and Esc for what's picked; Ctrl+Z (⌘Z) anywhere but a field
  useEffect(() => {
    if (!on) return;
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.defaultPrevented || target.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z") {
        const last = undo.current.pop();
        if (!last) return;
        event.preventDefault();
        setPicked(null);
        put(last.message, last.names, false);
        return;
      }
      if (!picked || event.metaKey || event.ctrlKey || event.altKey) return;
      if (KEYS[event.key]) {
        event.preventDefault();
        apply(KEYS[event.key]!);
      } else if ((event.key === "Delete" || event.key === "Backspace") && picked.index !== null) {
        event.preventDefault();
        apply(null);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setPicked(null);
      }
    }
    window.addEventListener("keydown", key, { capture: true });
    return () => window.removeEventListener("keydown", key, { capture: true });
  });

  // The toolbar goes when the chat scrolls, or a press lands anywhere else
  useEffect(() => {
    if (!picked) return;
    const box = column.current;
    function away(event: PointerEvent) {
      if (!toolbar.current?.contains(event.target as Node)) setPicked(null);
    }
    const scrolled = () => setPicked(null);
    box?.addEventListener("scroll", scrolled, { passive: true });
    document.addEventListener("pointerdown", away, { capture: true });
    return () => {
      box?.removeEventListener("scroll", scrolled);
      document.removeEventListener("pointerdown", away, { capture: true });
    };
  }, [picked, column]);

  const current = picked?.index != null ? message(picked.message)?.names?.[picked.index]?.kind : null;
  const bar = picked && (
    <div
      ref={toolbar}
      role="toolbar"
      aria-label={t("labelAs")}
      style={{ top: picked.top, left: picked.left }}
      // Pressing a button keeps the selection
      onPointerDown={(event) => event.preventDefault()}
      className="absolute z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 animate-in flex-wrap items-center gap-0.5 rounded-xl bg-white p-1 text-sm shadow-[0_4px_16px_rgb(0_0_0/0.18)] duration-100 fade-in"
    >
      {NAME_KINDS.map((kind, index) => (
        <button
          key={kind}
          type="button"
          onClick={() => apply(kind)}
          title={`${t(kind)} (${index + 1})`}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-2 py-1 hover:bg-tg-hover",
            current === kind && "bg-tg-hover font-medium",
          )}
        >
          <span className={cn("size-2.5 rounded-full", DOTS[kind])} aria-hidden="true" />
          {t(kind)}
          <kbd className="font-sans text-xs text-tg-muted">{index + 1}</kbd>
        </button>
      ))}
      {picked.index !== null && (
        <button
          type="button"
          onClick={() => apply(null)}
          title={`${t("remove")} (Delete)`}
          className="flex items-center gap-1 rounded-lg px-2 py-1 text-tg-wrong hover:bg-tg-hover"
        >
          <Trash2Icon className="size-4" aria-hidden="true" />
          {t("remove")}
        </button>
      )}
    </div>
  );
  return { pick: on ? pick : undefined, check: on ? check : undefined, toolbar: bar };
}
