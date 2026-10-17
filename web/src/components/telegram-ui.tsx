"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

// The pieces Telegram's pages here are made of, looking like Telegram's own: its font (Roboto), its blue, grey text,
// and round pictures that are the channel's initials on Telegram's colors while there's no photo

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

// The initials Telegram shows for a name: the first letters of its first two words ("Kun uz" gives KU)
function initialsOf(name: string): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase();
}

// A channel's round picture: its photo from Telegram's image server, or, without one (or until it loads, or if it
// fails), its initials on one of Telegram's colors
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
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-linear-to-b font-medium text-white",
        COLORS[id % COLORS.length],
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      <span aria-hidden="true">{initialsOf(name)}</span>
      {url && !failed && (
        // Straight from Telegram's image server: Next's image optimizer would fetch it through the site's server,
        // which can't reach the internet
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

// A text with its web addresses as links, in Telegram's blue
export function LinkedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'»])/g);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noreferrer"
            className="break-all text-tg-blue hover:underline"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}
