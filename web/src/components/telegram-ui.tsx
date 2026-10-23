"use client";

import type { LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ComponentProps, Fragment, type ReactNode, useEffect, useRef, useState } from "react";

import type { LabelledName } from "@/api/types.gen";
import { cn } from "@/lib/utils";

// The pieces Telegram's pages here are made of, looking like Telegram Web's own

// Telegram's seven colors for a picture without a photo (red, orange, violet, green, cyan, blue, pink), picked by the
// channel's ID as Telegram picks them
const COLORS = [
  "from-[#ff885e] to-[#ff516a]",
  "from-[#ffcd6a] to-[#ffa85c]",
  "from-[#82b1ff] to-[#665fff]",
  "from-[#a0de7e] to-[#54cb68]",
  "from-[#53edd6] to-[#28c9b7]",
  "from-[#72d5fd] to-[#2a9ef1]",
  "from-[#e0a2f3] to-[#d669ed]",
];

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" }); // what one sees as one letter or emoji

// The letter Telegram shows on a channel's picture without a photo: the first of its name, punctuation aside, or the
// emoji it starts with
function initialOf(name: string): string {
  const word = name.replace(/[.,!@#$%^&*()_+=\-`~[\]/\\{}:"|<>?]+/g, "").trim();
  const first = GRAPHEMES.segment(word)[Symbol.iterator]().next();
  return first.done ? "" : first.value.segment.toUpperCase();
}

// A channel's round picture: its photo (the saved one, from the API, or Telegram's own link while none is saved), or,
// without one (or until it loads, or if it fails), its letter in bold on one of Telegram's colors
export function ChannelPhoto({
  id,
  name,
  url,
  size,
  className,
}: {
  id: number;
  name: string;
  url: string | null;
  size: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-linear-to-b [font-family:var(--tg-rounded)] leading-none font-bold text-white",
        COLORS[id % COLORS.length],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(size / 2 - 4, 8) }}
    >
      <span aria-hidden="true">{initialOf(name)}</span>
      {url && !failed && (
        // A plain image: Next's image optimizer would fetch it through the site's server, which can't reach Telegram's
        // image server
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}

// What a message's text links to, as Telegram shows it. The saved text keeps a link hidden behind words as the words
// with the address after them in brackets ("Telegram (https://t.me/kunuz)", after a space more when the words ended
// with one): Telegram shows only the words, in blue, so here the word before the brackets takes the link. Addresses, with or without https:// (kun.uz), @usernames
// (their channels on Telegram) and #hashtags (searched for in the chat, as Telegram does) are blue too.
const TEXT_LINK = String.raw`(\S+)([^\S\n]*)[^\S\n]\((https?:\/\/[^\s()]+)\)`;
const URL = String.raw`https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'»]`;
const DOMAIN = String.raw`(?<![\w@/.-])(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:uz|ru|com|org|net|io|me|info|tv|news|app|dev|kz|kg|tj|tm|ua|by|az|tr|de|uk|us|eu|gov|edu|co|online|site|xyz)(?:\/[^\s<>"]*[^\s<>".,;:!?)\]}'»])?(?![\w-])`;
const MENTION = String.raw`(?<![\w@])@[a-z][\w]{3,31}`;
const HASHTAG = String.raw`(?<![\w#])#(?=[\p{L}\p{N}_]*\p{L})[\p{L}\p{N}_]+`;
const LINKED = new RegExp(`${TEXT_LINK}|(${URL})|(${DOMAIN})|(${MENTION})|(${HASHTAG})`, "giu");

const LINK = "text-tg-blue [overflow-wrap:anywhere] hover:underline";

type Placed = LabelledName & { start: number; end: number; index: number };

// A message's (or a description's) text with its links, the names labelled in it marked by their kind, and what a search
// found in it marked as Telegram marks it. With names, each piece of the text says where it starts in it (data-at, in
// UTF-16 units) and each name's mark which of them it is (data-name), so that what's selected or clicked in it can be
// told (see placeOf). Raw, the text is shown as it's saved, and as name finders read it: without links, a link hidden
// behind words with its address after them.
export function TelegramText({
  text,
  found,
  names,
  raw = false,
  onHashtag,
}: {
  text: string;
  found?: string;
  names?: LabelledName[] | null;
  raw?: boolean;
  onHashtag?: (tag: string) => void;
}) {
  const placed = (names ?? [])
    .map((name, index) => ({ ...name, index }))
    .filter((name): name is Placed => name.start !== null && name.end !== null)
    .sort((a, b) => a.start - b.start);
  const located = !!names;
  const mark = (piece: string, from: number) =>
    located ? (
      <span key={from} data-at={from}>
        <Marked text={piece} at={from} found={found} names={placed} />
      </span>
    ) : (
      <Marked key={from} text={piece} at={from} found={found} names={placed} />
    );
  if (raw) return mark(text, 0);
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(LINKED)) {
    const [whole, words, after, hidden, url, domain, mention, hashtag] = match;
    const start = match.index;
    if (start > at) parts.push(mark(text.slice(at, start), at));
    if (words && hidden) {
      parts.push(
        <a key={start} href={hidden} target="_blank" rel="noreferrer" className={LINK}>
          {mark(words, start)}
        </a>,
        located && after ? mark(after, start + words.length) : after,
      );
    } else if (url || domain) {
      parts.push(
        <a key={start} href={url ?? `https://${domain}`} target="_blank" rel="noreferrer" className={LINK}>
          {mark(whole, start)}
        </a>,
      );
    } else if (mention) {
      parts.push(
        <a key={start} href={`https://t.me/${mention.slice(1)}`} target="_blank" rel="noreferrer" className={LINK}>
          {mark(whole, start)}
        </a>,
      );
    } else if (hashtag) {
      parts.push(
        <button key={start} type="button" onClick={() => onHashtag?.(hashtag)} className={cn(LINK, "inline")}>
          {mark(whole, start)}
        </button>,
      );
    }
    at = start + whole.length;
  }
  if (at < text.length) parts.push(mark(text.slice(at), at));
  return <>{parts}</>;
}

// A piece of a text, which starts at at in it, with the names in it marked (a name split by a link is marked on each
// side of it), and what a search found
function Marked({ text, at, found, names }: { text: string; at: number; found?: string; names: Placed[] }) {
  const end = at + text.length;
  const parts: ReactNode[] = [];
  let from = at;
  for (const name of names) {
    if (name.end <= from || name.start >= end) continue;
    const start = Math.max(name.start, from);
    const stop = Math.min(name.end, end);
    if (start > from) parts.push(<Found key={from} text={text.slice(from - at, start - at)} found={found} />);
    parts.push(
      <NameMark
        key={start}
        kind={name.kind}
        name={name.name}
        verdict={name.verdict}
        labelledAs={name.labelled_as}
        index={name.index}
      >
        <Found text={text.slice(start - at, stop - at)} found={found} />
      </NameMark>,
    );
    from = stop;
  }
  if (parts.length === 0) return <Found text={text} found={found} />;
  if (from < end) parts.push(<Found key={from} text={text.slice(from - at)} found={found} />);
  return parts;
}

// The kinds of names labelled in messages, in the order they're listed, each marked on a light shade of its color,
// underlined with the color itself; a name a model missed, framed with the color, dashed
export const NAME_KINDS = [
  "person",
  "organization",
  "location",
  "event",
] as const satisfies readonly LabelledName["kind"][];
const FILLS = {
  person: "bg-tg-person/14",
  organization: "bg-tg-organization/18",
  location: "bg-tg-location/16",
  event: "bg-tg-event/16",
};
const LINES = {
  person: "shadow-[inset_0_-2px_0_var(--color-tg-person)]",
  organization: "shadow-[inset_0_-2px_0_var(--color-tg-organization)]",
  location: "shadow-[inset_0_-2px_0_var(--color-tg-location)]",
  event: "shadow-[inset_0_-2px_0_var(--color-tg-event)]",
};
const FRAMES = {
  person: "border-tg-person",
  organization: "border-tg-organization",
  location: "border-tg-location",
  event: "border-tg-event",
};
// A model's mistake (a name not labelled by hand, or of another kind): red and wavy underneath, as a misspelt word
export const MISTAKE =
  "underline decoration-tg-wrong decoration-wavy decoration-1 underline-offset-[3px] [text-decoration-skip-ink:none]";
export const MISSED = "border border-dashed [box-decoration-break:clone]";

// A name labelled by hand, or by another labeller, marked by its kind (and another's by how it compares with the
// hand's, see LabelledName), which, with the name, shows under the mouse; without a name, the mark alone. In a text,
// index is which of its names it is.
export function NameMark({
  kind,
  name,
  verdict,
  labelledAs,
  index,
  children,
}: {
  kind: LabelledName["kind"];
  name?: string;
  verdict?: LabelledName["verdict"];
  labelledAs?: LabelledName["labelled_as"];
  index?: number;
  children: ReactNode;
}) {
  const t = useTranslations("telegramChannel");
  let title = name && `${t(kind)}: ${name}`;
  if (title && verdict) title += ` — ${t(`verdicts.${verdict}`, { kind: labelledAs ? t(labelledAs) : "" })}`;
  let look;
  if (verdict === "missed") look = cn(MISSED, FRAMES[kind]);
  else if (verdict === "kind" || verdict === "extra") look = cn(FILLS[kind], MISTAKE);
  else look = cn(FILLS[kind], LINES[kind]);
  return (
    <mark title={title} data-name={index} className={cn("rounded-[3px] bg-transparent text-inherit", look)}>
      {children}
    </mark>
  );
}

// Where a point of a selection is in the text TelegramText shows, with names, in UTF-16 units: the piece it's in (data-at)
// and how far into it; null outside the text (in a message's time, say)
export function placeOf(box: HTMLElement, node: Node, offset: number): number | null {
  const element = node instanceof Element ? node : node.parentElement;
  const piece = element?.closest<HTMLElement>("[data-at]");
  if (!piece || !box.contains(piece)) return null;
  const range = document.createRange();
  range.setStart(piece, 0);
  range.setEnd(node, offset);
  return Number(piece.dataset.at) + range.toString().length;
}

// A text with each place a search found in it (its letters' case aside) on Telegram's light blue
function Found({ text, found }: { text: string; found?: string }) {
  if (!found) return text;
  const pattern = new RegExp(`(${found.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "giu");
  return text.split(pattern).map((part, index) =>
    index % 2 ? (
      <mark key={index} className="rounded-[4px] bg-tg-highlight px-0.5 text-inherit">
        {part}
      </mark>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

// A message's text on one line, as a chat list shows it: a link hidden behind words as the words alone, and the lines
// run together
export function oneLine(text: string): string {
  return text.replace(new RegExp(TEXT_LINK, "giu"), "$1$2").replace(/\s+/g, " ").trim();
}

// Telegram's ripple, inside what's pressed (which clips it): a grey circle growing from the pointer, which fades
export function Ripples({ className }: { className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const container = box.current;
    const pressed = container?.parentElement;
    if (!container || !pressed) return;
    function press(event: PointerEvent) {
      if (!container || event.button !== 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const area = container.getBoundingClientRect();
      const size = Math.max(area.width, area.height);
      const wave = document.createElement("span");
      wave.className = "absolute block rounded-full bg-black/8 animate-tg-ripple";
      Object.assign(wave.style, {
        transform: "scale(0)",
        width: `${size}px`,
        height: `${size}px`,
        left: `${event.clientX - area.left - size / 2}px`,
        top: `${event.clientY - area.top - size / 2}px`,
      });
      wave.addEventListener("animationend", () => wave.remove());
      container.append(wave);
    }
    pressed.addEventListener("pointerdown", press);
    return () => pressed.removeEventListener("pointerdown", press);
  }, []);
  return (
    <span
      ref={box}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit] [corner-shape:inherit]",
        className,
      )}
    />
  );
}

// Telegram's round 40 px button with an icon, grey under the mouse, with its ripple
export function RoundButton({ label, className, children, ...props }: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center rounded-full text-black transition-colors hover:bg-[rgb(112_117_121/0.08)]",
        className,
      )}
      {...props}
    >
      {children}
      <Ripples />
    </button>
  );
}

// Telegram's colored squares behind the white icons of a channel's info
const BACKDROPS = {
  blue: "bg-[#2196f3]",
  gray: "bg-[#78909c]",
  green: "bg-[#4caf50]",
  orange: "bg-[#fb8c00]",
} as const;

// A line of a channel's info, as Telegram's: the icon on its colored square, the value, and what it is below it, grey.
// With onClick, the whole line is a button.
export function InfoRow({
  icon: Icon,
  color,
  label,
  onClick,
  children,
}: {
  icon: LucideIcon;
  color: keyof typeof BACKDROPS;
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const content = (
    <>
      <span
        className={cn(
          "mt-3 flex size-[30px] shrink-0 items-center justify-center rounded-[10px] text-white",
          BACKDROPS[color],
        )}
      >
        <Icon className="size-5" strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 pt-[7px] pb-[9px]">
        <span className="block text-base leading-5 break-words whitespace-pre-wrap">{children}</span>
        <span className="mt-1 block text-sm leading-4 text-tg-muted">{label}</span>
      </span>
    </>
  );
  const shape = "relative flex w-full items-start gap-[1.125rem] px-4 text-left tg-item";
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(shape, "hover:bg-tg-hover")}>
      {content}
      <Ripples />
    </button>
  ) : (
    <div className={shape}>{content}</div>
  );
}

// A filled arrow pointing right and up, as on Telegram's button beside a channel's post
export function ShareIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M13.2 4.6c-.6-.5-1.5-.1-1.5.7v3.4C6.1 9.3 3.2 13 3 18.7c0 .5.6.7.9.3 1.8-2.7 4.3-4 7.8-4.2v3.6c0 .8.9 1.2 1.5.7l7.6-6.6c.4-.4.4-1 0-1.4z" />
    </svg>
  );
}

// Under a labelled text: the names labelled by hand that a model missed, the names that couldn't be marked in the text,
// or that it has none
export function NameNotes({ names }: { names: LabelledName[] }) {
  const t = useTranslations("telegramChannel");
  if (names.length === 0) return <span className="mt-1 block text-sm leading-5 text-tg-muted">{t("noNames")}</span>;
  // A missed name once, wherever the hand placed it
  const missed = [...new Map(names.filter((name) => name.verdict === "missed").map((n) => [n.kind + n.name, n]))];
  const unmarked = names.filter((name) => name.start === null && name.verdict !== "missed");
  if (missed.length === 0 && unmarked.length === 0) return null;
  return (
    <span className="mt-1 block text-sm leading-5 text-tg-muted">
      {missed.length > 0 && <NameList label={t("missed")} names={missed.map(([, name]) => name)} />}
      {unmarked.length > 0 && <NameList label={t("notMarked")} names={unmarked} />}
    </span>
  );
}

function NameList({ label, names }: { label: string; names: LabelledName[] }) {
  return (
    <span className="block">
      {label}{" "}
      {names.map((name, index) => (
        <Fragment key={index}>
          {index > 0 && ", "}
          <NameMark kind={name.kind} name={name.name} verdict={name.verdict} labelledAs={name.labelled_as}>
            <span className="text-black">{name.name}</span>
          </NameMark>
        </Fragment>
      ))}
    </span>
  );
}
