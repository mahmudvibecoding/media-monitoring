"use client";

import type { MouseEvent, ReactNode } from "react";

import { usePlayer } from "@/components/youtube-player";
import { handleOnYouTube, hashtagOnYouTube } from "@/lib/youtube";

// What YouTube turns into links in a description or a comment: web addresses, #hashtags, @handles, and times (1:23,
// 1:02:03), which take the video to that second
const LINKED =
  /(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]}'»])|(?<![\p{L}\p{N}_])(#[\p{N}_]*\p{L}[\p{L}\p{N}_]*)|(?<![\p{L}\p{N}_.])(@[\p{L}\p{N}_][\p{L}\p{N}_.-]{1,28}[\p{L}\p{N}_])|(?<![\d:])((?:\d{1,2}:)?\d{1,2}:[0-5]\d)(?![\d:])/gu;

// The seconds a time stands for: 1:02:03 is 3,723
const secondsOf = (time: string) => time.split(":").reduce((total, part) => total * 60 + Number(part), 0);

// A link in the text doesn't also do what a click on the text around it does (open the description)
const own = (event: MouseEvent) => event.stopPropagation();

// A text with YouTube's links in YouTube's blue: addresses, hashtags and handles open on YouTube (in a new tab), and
// times take the page's player there, when the page has one
export function YouTubeText({ text }: { text: string }) {
  const player = usePlayer();
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINKED)) {
    const [whole, address, hashtag, handle, time] = match;
    const at = match.index;
    if (at > last) parts.push(text.slice(last, at));
    const link = "text-yt-blue";
    if (address) {
      parts.push(
        <a key={at} href={address} target="_blank" rel="noreferrer" onClick={own} className={`${link} break-all`}>
          {address}
        </a>,
      );
    } else if (hashtag) {
      parts.push(
        <a
          key={at}
          href={hashtagOnYouTube(hashtag.slice(1))}
          target="_blank"
          rel="noreferrer"
          onClick={own}
          className={link}
        >
          {hashtag}
        </a>,
      );
    } else if (handle) {
      parts.push(
        <a key={at} href={handleOnYouTube(handle)} target="_blank" rel="noreferrer" onClick={own} className={link}>
          {handle}
        </a>,
      );
    } else if (time && player) {
      parts.push(
        <button
          key={at}
          type="button"
          onClick={(event) => {
            own(event);
            player.current?.seek(secondsOf(time));
          }}
          className={link}
        >
          {time}
        </button>,
      );
    } else {
      parts.push(whole);
    }
    last = at + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

// A text's hashtags, each once, in their order: YouTube shows a description's first three by the views
export function hashtagsOf(text: string | null): string[] {
  const tags = new Set<string>();
  for (const match of (text ?? "").matchAll(LINKED)) if (match[2]) tags.add(match[2]);
  return [...tags];
}
