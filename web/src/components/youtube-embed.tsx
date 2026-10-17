"use client";

import { type CSSProperties, type RefObject, useEffect, useRef } from "react";

// YouTube's player as the pages here play it. Whatever its address asks (controls=0 too), the player puts its own ⏸ in
// the middle of the video for about 4 s each time a video starts, goes on after a pause, jumps or changes (measured).
// That ⏸ keeps its size (about 56 px) whatever the player's, so the pages draw the player 48 times as big as they show
// it and shrink it back: the ⏸ comes out about a pixel across, which can't be seen (at 16 and 24 times it still could,
// on a Retina screen; at 32, barely), while the video stays sharp. YouTube picks the video's quality for the player's
// size, so it streams its best (4K, where a video has it; it still lowers it on a slow connection): a player drawn 4
// times as big already did. As a playlist of itself (YouTube's way to play a video round again), the player would add
// its ⏮ ⏭ beside the ⏸: the pages start a video again themselves at its end.

export const PLAYER = "https://www.youtube-nocookie.com"; // YouTube's privacy-enhanced address for its player
export const ENDED = 0;
export const PLAYING = 1;
export const PAUSED = 2;
export const BUFFERING = 3;
const SCALE = 48; // times the player is drawn as big as its frame

// What a player tells the page listening to it: its state, where it's at, the video's length, its sound, how much of the
// video is loaded, and its speed
export type PlayerInfo = {
  playerState?: number;
  currentTime?: number;
  duration?: number;
  muted?: boolean;
  volume?: number;
  videoLoadedFraction?: number;
  playbackRate?: number;
};

// A player's address: the video, playing at once (unless not), from a second, with or without sound, without YouTube's
// controls, and taking the page's commands
export function embed(id: string, { from = 0, muted = false, autoplay = true } = {}) {
  const params = new URLSearchParams({
    controls: "0",
    rel: "0",
    playsinline: "1",
    enablejsapi: "1",
    iv_load_policy: "3",
    disablekb: "1",
    fs: "0",
  });
  if (autoplay) params.set("autoplay", "1");
  if (muted) params.set("mute", "1");
  if (from >= 1) params.set("start", String(Math.floor(from)));
  return `${PLAYER}/embed/${id}?${params}`;
}

// A command to a player (playVideo, seekTo…)
export function command(frame: HTMLIFrameElement | null, func: string, args: unknown[] = []) {
  frame?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), PLAYER);
}

// Tells a player that the page listens, which it answers by telling about itself from then on
export function listen(frame: HTMLIFrameElement) {
  frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: frame.title, channel: "widget" }), PLAYER);
}

// What a message from the player in frame says of it, or null for any other message
export function infoOf(event: MessageEvent, frame: HTMLIFrameElement | null): PlayerInfo | null {
  if (!frame || event.source !== frame.contentWindow || typeof event.data !== "string") return null;
  try {
    const info = JSON.parse(event.data)?.info;
    return info && typeof info === "object" ? (info as PlayerInfo) : null;
  } catch {
    return null; // not the player's
  }
}

// The style of a player drawn 48 times as big as its frame and shrunk back into it, and `crop` px taller than the
// frame at each end, so that the video fills the frame as the page wants it
export function scaled(crop: number): CSSProperties {
  return {
    top: -crop,
    left: 0,
    width: `${SCALE * 100}%`,
    height: `calc((100% + ${2 * crop}px) * ${SCALE})`,
    transform: `scale(${1 / SCALE})`,
    transformOrigin: "0 0",
  };
}

// A player of a video, for an iframe to take as its ref: loaded only as its page shows (an effect, which a hidden page
// doesn't run, gives it its address, as address() makes it then) and unloaded as it goes, so nothing plays unseen in a
// page Next keeps alive; meanwhile, what it says of itself goes to heard (with a way to answer it), and once loaded
// it's told the page listens
export function useEmbedded(
  id: string,
  address: () => string,
  heard: (info: PlayerInfo, send: (func: string, args?: unknown[]) => void) => void,
): RefObject<HTMLIFrameElement | null> {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ address, heard });
  useEffect(() => {
    latest.current = { address, heard };
  });
  useEffect(() => {
    const player = frame.current;
    if (!player) return;
    const opened = () => listen(player);
    const message = (event: MessageEvent) => {
      const info = infoOf(event, player);
      if (info) latest.current.heard(info, (func, args) => command(player, func, args));
    };
    window.addEventListener("message", message);
    player.addEventListener("load", opened);
    player.src = latest.current.address();
    return () => {
      window.removeEventListener("message", message);
      player.removeEventListener("load", opened);
      player.src = "about:blank";
    };
  }, [id]);
  return frame;
}
