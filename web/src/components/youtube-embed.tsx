"use client";

import { type CSSProperties, type RefObject, useCallback, useEffect, useRef, useState } from "react";

// YouTube's player as the pages here play it. Whatever its address asks (controls=0 too), the player puts its own ⏸ in
// the middle of the video for about 4 s each time a video starts, goes on after a pause, jumps or changes (measured);
// it shows nothing of its own while the video plays on, while it's paused, or as its sound changes. That ⏸ keeps its
// size whatever the player's, so the pages draw the player several times as big as they show it and shrink it back:
// the ⏸ comes out a fraction of its size (the video, chosen for the bigger player, stays sharp), and for those seconds
// a soft blur over the middle (Hush) hides what's left of it. As a playlist of itself (YouTube's way to play a video
// round again), the player would add its ⏮ ⏭ beside it: the pages start a video again themselves at its end.

export const PLAYER = "https://www.youtube-nocookie.com"; // YouTube's privacy-enhanced address for its player
export const ENDED = 0;
export const PLAYING = 1;
export const PAUSED = 2;
export const BUFFERING = 3;
const ITS_BUTTON_FOR = 4500; // ms YouTube's ⏸ stays after a start, a seek or a change (3.5 to 4.5 s, measured)

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

// The style of a player drawn `scale` times as big as its frame and shrunk back into it, and `crop` px taller than the
// frame at each end, so that what YouTube puts along the player's top and bottom falls outside it
export function scaled(scale: number, crop: number): CSSProperties {
  return {
    top: -crop,
    left: 0,
    width: `${scale * 100}%`,
    height: `calc((100% + ${2 * crop}px) * ${scale})`,
    transform: `scale(${1 / scale})`,
    transformOrigin: "0 0",
  };
}

// Whether YouTube's ⏸ is in the middle of the video now, and what to call each time it comes back (a start, a seek, a
// change of video, going on after a pause)
export function useHush() {
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hush = useCallback(() => {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOn(false), ITS_BUTTON_FOR);
  }, []);
  return [on, hush] as const;
}

// A soft blur over the middle of the video, size px across, its edge fading, which hides YouTube's shrunk ⏸
export function Hush({ size }: { size: number }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 left-1/2 -translate-1/2 rounded-full"
      style={{
        width: size,
        height: size,
        backdropFilter: `blur(${Math.round(size / 5)}px)`,
        WebkitBackdropFilter: `blur(${Math.round(size / 5)}px)`,
        maskImage: "radial-gradient(circle, #000 50%, transparent 70%)",
        WebkitMaskImage: "radial-gradient(circle, #000 50%, transparent 70%)",
      }}
    />
  );
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
