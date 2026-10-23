"use client";

import { Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type MouseEvent, type RefObject, useEffect, useRef, useState } from "react";

import type { LabelledName } from "@/api/types.gen";
import { NAME_KINDS, placeOf } from "@/components/telegram-ui";
import { cn } from "@/lib/utils";

// Correcting the names labelled by hand in texts, as admins do in Telegram's messages and YouTube's texts: a selection
// of a text is labelled a person, an organization, a place or an event from the toolbar that comes up under it (or with
// 1 to 4), and a name clicked gets another kind, or is removed (Delete). Each change shows at once and is saved at
// once; Ctrl+Z takes the last ones back, one at a time. Where the texts are kept, and how they're saved, is each page's
// (a NameStore): Telegram's chats (telegram-labels.tsx) and YouTube's labelled channels (youtube-labels.tsx).

type Kind = LabelledName["kind"];
// What's picked in text key: a selection (index null) or one of its names (its index), where it is in the text, in
// UTF-16 units, and where the toolbar goes, in its area
type Picked<K> = { key: K; start: number; end: number; index: number | null; top: number; left: number };
export type Pick<K> = (key: K, start: number, end: number, index: number | null, rect: DOMRect) => void;

// Where a page's texts are: a text's words and names by its key, showing names at once, saving them (which gives them
// back as saved), and telling the admin a change wasn't saved
export type NameStore<K> = {
  find: (key: K) => { text: string; names?: LabelledName[] | null } | undefined;
  show: (key: K, names: LabelledName[]) => void;
  save: (
    key: K,
    names: LabelledName[],
    done: { onSuccess: (saved: LabelledName[]) => void; onError: () => void },
  ) => void;
  failed: () => void;
};

const KEYS: Record<string, Kind> = { "1": "person", "2": "organization", "3": "location", "4": "event" };
export const DOTS = {
  person: "bg-tg-person",
  organization: "bg-tg-organization",
  location: "bg-tg-location",
  event: "bg-tg-event",
};
const WORD = /[\p{L}\p{N}\p{M}'ʻʼ‘’`´]/u; // what words are made of: letters, digits, Uzbek's apostrophes
const EDGE = /[\s.,;:!?()[\]{}'ʻʼ‘’`´—–-]/u; // what's left off a name's ends
const QUOTES: Record<string, string> = { "«": "»", '"': '"', "“": "”", "„": "“" };
const OPENING = /["«“„]/u;
const CLOSING = /["»”“]/u;
const ONLY_CLOSING = /[»”]/u; // never open a quote, so an ending after one is an ending after a quote
const TOOLBAR_HEIGHT = 44; // px, about: above the selection when there's no room under it
const TOOLBAR_HALF = 260; // px, about half its width with its Remove: it's kept that far from the area's sides

// A selection made a name: out to whole words (a name takes its endings: Toshkentda), without spaces and punctuation at
// its ends; a name in quotes is only what's inside them, an ending after the closing quote left out («Artel» → Artel,
// "Сити"нинг → Сити), while quotes inside a longer name stay («Chorsu» bozori)
export function snapName(text: string, start: number, end: number): [number, number] {
  while (start > 0 && start < text.length && WORD.test(text[start - 1]!) && WORD.test(text[start]!)) start--;
  while (end > 0 && end < text.length && WORD.test(text[end - 1]!) && WORD.test(text[end]!)) end++;
  while (start < end && EDGE.test(text[start]!)) start++;
  while (end > start && EDGE.test(text[end - 1]!)) end--;
  let ending = end; // where the last word's letters begin
  while (ending > start && WORD.test(text[ending - 1]!)) ending--;
  const quote = text[ending - 1] ?? "";
  const quoted = ONLY_CLOSING.test(quote) || OPENING.test(text[start]!) || OPENING.test(text[start - 1] ?? "");
  if (quoted && ending < end && ending - 2 >= start && CLOSING.test(quote) && WORD.test(text[ending - 2]!))
    end = ending - 1;
  // A quote mark at an end without its pair in the name is left out
  if (end - start > 1 && OPENING.test(text[start]!) && !CLOSING.test(text.slice(start + 1, end))) start++;
  if (end - start > 1 && CLOSING.test(text[end - 1]!) && !OPENING.test(text.slice(start, end - 1))) end--;
  const close = QUOTES[text[start]!];
  if (close && end - start > 2 && text[end - 1] === close) return [start + 1, end - 1];
  return [start, end];
}

// How a text's box picks, with onPick: a selection of its text, made whole words, or a click on one of its names (a
// name in a link is picked, the link not followed); its handlers, for the element that holds the text
export function usePicking<K>(
  box: RefObject<HTMLElement | null>,
  key: K,
  text: string,
  names: LabelledName[] | null | undefined,
  onPick?: Pick<K>,
) {
  function selected() {
    const selection = window.getSelection();
    if (!onPick || !box.current || !selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const from = placeOf(box.current, range.startContainer, range.startOffset);
    const to = placeOf(box.current, range.endContainer, range.endOffset);
    if (from === null || to === null) return;
    const [start, end] = snapName(text, Math.min(from, to), Math.max(from, to));
    if (start < end) onPick(key, start, end, null, range.getBoundingClientRect());
  }

  function clicked(event: MouseEvent<HTMLElement>) {
    if (!onPick || !window.getSelection()?.isCollapsed) return;
    const mark = (event.target as Element).closest<HTMLElement>("mark[data-name]");
    const name = mark && names?.[Number(mark.dataset.name)];
    if (!mark || !name || name.start === null || name.end === null) return;
    event.preventDefault();
    onPick(key, name.start, name.end, Number(mark.dataset.name), mark.getBoundingClientRect());
  }

  if (!onPick) return {};
  return {
    onMouseUp: () => setTimeout(selected),
    onKeyUp: (event: { shiftKey: boolean }) => event.shiftKey && selected(),
    onTouchEnd: () => setTimeout(selected, 300),
    onClick: clicked,
  };
}

// The editing of a page's names, while on: what's picked, the toolbar to label it with (placed in area, which is
// positioned), and how texts pick (see usePicking). Scrolling scroller, or a press anywhere else, puts the toolbar away.
export function useNameEditing<K>({
  store,
  area,
  scroller,
  on,
}: {
  store: NameStore<K>;
  area: () => HTMLElement | null | undefined;
  scroller?: () => HTMLElement | null | undefined;
  on: boolean;
}) {
  const t = useTranslations("telegramChannel");
  const [picked, setPicked] = useState<Picked<K> | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const undo = useRef<{ key: K; names: LabelledName[] }[]>([]);

  // Shows a text's names at once and saves them; back as they were if they couldn't be saved
  function put(key: K, names: LabelledName[], remember = true) {
    const before = store.find(key)?.names ?? [];
    if (remember) undo.current.push({ key, names: before });
    store.show(key, names);
    store.save(key, names, {
      onSuccess: (saved) => store.show(key, saved),
      onError: () => {
        store.show(key, before);
        store.failed();
      },
    });
  }

  // A kind for what's picked, or, with null, its removal
  function apply(kind: Kind | null) {
    if (!picked) return;
    const found = store.find(picked.key);
    setPicked(null);
    window.getSelection()?.removeAllRanges();
    if (!found) return;
    const names = found.names ?? [];
    const { key, start, end, index } = picked;
    if (index !== null) {
      put(key, kind ? names.map((n, i) => (i === index ? { ...n, kind } : n)) : names.filter((_, i) => i !== index));
    } else if (kind) {
      // A new name takes the place of those it overlaps
      const kept = names.filter((n) => n.start === null || n.end === null || n.end <= start || n.start >= end);
      const added = { name: found.text.slice(start, end), kind, start, end };
      put(
        key,
        [...kept, added].sort((a, b) => (a.start ?? 0) - (b.start ?? 0)),
      );
    }
  }

  const pick: Pick<K> = (key, start, end, index, rect) => {
    const box = area()?.getBoundingClientRect();
    if (!on || !box) return;
    const under = rect.bottom - box.top + 6;
    const top = under + TOOLBAR_HEIGHT > box.height ? rect.top - box.top - TOOLBAR_HEIGHT - 6 : under;
    const middle = rect.left + rect.width / 2 - box.left;
    const half = Math.min(TOOLBAR_HALF, box.width / 2);
    const left = Math.min(Math.max(middle, half), box.width - half);
    setPicked({ key, start, end, index, top, left });
  };

  // Keys, before the page's own (capture): 1 to 4, Delete and Esc for what's picked; Ctrl+Z (⌘Z) anywhere but a field
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
        put(last.key, last.names, false);
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

  // The toolbar goes when the scroller scrolls, or a press lands anywhere else
  useEffect(() => {
    if (!picked) return;
    const box = scroller?.();
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
  }, [picked, scroller]);

  const current = picked?.index != null ? store.find(picked.key)?.names?.[picked.index]?.kind : null;
  const bar = picked && (
    <div
      ref={toolbar}
      role="toolbar"
      aria-label={t("labelAs")}
      style={{ top: picked.top, left: picked.left }}
      // Pressing a button keeps the selection
      onPointerDown={(event) => event.preventDefault()}
      className="absolute z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 animate-in flex-wrap items-center gap-0.5 rounded-xl bg-white p-1 text-sm text-black shadow-[0_4px_16px_rgb(0_0_0/0.18)] duration-100 fade-in"
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
  return { pick: on ? pick : undefined, toolbar: bar };
}
