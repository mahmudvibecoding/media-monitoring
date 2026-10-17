"use client";

import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

const PLAYER = "https://www.youtube-nocookie.com"; // YouTube's privacy-enhanced address for its player

// The player's address for a video: playing it at once, from a second if given, and taking the page's commands
const embed = (id: string, from = 0) =>
  `${PLAYER}/embed/${id}?autoplay=1&rel=0&enablejsapi=1${from > 0 ? `&start=${from}` : ""}`;

// What a page can ask of its player: to go to a second (a time in the description or a comment), and where it's at
export type PlayerControls = { seek: (seconds: number) => void; position: () => number };

const PlayerContext = createContext<RefObject<PlayerControls | null> | null>(null);

// Around a video's page: lets its texts' times reach its player
export function PlayerProvider({ children }: { children: ReactNode }) {
  const controls = useRef<PlayerControls | null>(null);
  return <PlayerContext value={controls}>{children}</PlayerContext>;
}

// The page's player, once it's there (null outside a video's page)
export const usePlayer = () => useContext(PlayerContext);

// What the player last told about itself: where it's at, whether it plays, whether it's muted, the video's length
type State = { currentTime?: number; playerState?: number; muted?: boolean; duration?: number };
const PLAYING = 1;
const BUFFERING = 3;

// The video, played here by YouTube's own player, which starts it as the page opens (with sound once one has clicked
// anything on the site, as browsers allow; without, the player waits for a click). YouTube wants to know which site the
// player is on (the address this page sends with the request), so unlike the pictures it isn't asked for without one.
// The player tells a page that has said it's listening where it's at, and takes its commands. Next keeps a page one has
// left alive, hidden, for going back to it: the player is loaded only as its page shows (an effect, which a hidden page
// doesn't run, gives it its address), unloaded as the page goes, so that nothing plays there unseen, and loaded again
// as it comes back, from the second it had got to. YouTube's keys work on the page as on YouTube's (while the player
// itself has the focus, it takes them): K or the space bar plays and pauses, J and L go 10 s back and on, ← and → 5 s,
// M mutes, F fills the screen, and 0 to 9 go to that tenth of the video.
export function Player({
  id,
  title,
  vertical = false,
  className,
}: {
  id: string;
  title: string;
  vertical?: boolean;
  className?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const state = useRef<State>({});
  const controlsRef = usePlayer();
  useEffect(() => {
    const player = frame.current;
    if (!player) return;
    const send = (func: string, args: unknown[] = []) =>
      player.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), PLAYER);
    const listen = () =>
      player.contentWindow?.postMessage(JSON.stringify({ event: "listening", id, channel: "widget" }), PLAYER);
    function heard(event: MessageEvent) {
      if (event.source !== player?.contentWindow || typeof event.data !== "string") return;
      try {
        const info = JSON.parse(event.data)?.info;
        if (info && typeof info === "object") state.current = { ...state.current, ...info };
      } catch {
        // not the player's message
      }
    }
    const seek = (seconds: number) => {
      send("seekTo", [Math.max(0, seconds), true]);
      state.current.currentTime = Math.max(0, seconds);
    };
    const at = () => state.current.currentTime ?? 0;
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || target.isContentEditable) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const playing = state.current.playerState === PLAYING || state.current.playerState === BUFFERING;
      const length = state.current.duration ?? 0;
      switch (event.key) {
        case " ":
          if (["BUTTON", "A"].includes(target.tagName)) return; // the space bar presses what has the focus
          send(playing ? "pauseVideo" : "playVideo");
          break;
        case "k":
          send(playing ? "pauseVideo" : "playVideo");
          break;
        case "j":
          seek(at() - 10);
          break;
        case "l":
          seek(at() + 10);
          break;
        case "ArrowLeft":
          seek(at() - 5);
          break;
        case "ArrowRight":
          seek(at() + 5);
          break;
        case "m":
          send(state.current.muted ? "unMute" : "mute");
          state.current.muted = !state.current.muted;
          break;
        case "f":
          void player.requestFullscreen?.();
          break;
        default:
          if (/^[0-9]$/.test(event.key) && length > 0) seek((length * Number(event.key)) / 10);
          else return;
      }
      event.preventDefault();
    };
    window.addEventListener("message", heard);
    window.addEventListener("keydown", key);
    player.addEventListener("load", listen);
    if (controlsRef) {
      controlsRef.current = {
        seek: (seconds) => {
          seek(seconds);
          send("playVideo");
          window.scrollTo({ top: 0, behavior: "smooth" }); // the player is at the top of the page
        },
        position: at,
      };
    }
    player.src = embed(id, Math.floor(at())); // from the start, or from where it was
    return () => {
      window.removeEventListener("message", heard);
      window.removeEventListener("keydown", key);
      player.removeEventListener("load", listen);
      if (controlsRef) controlsRef.current = null;
      player.src = "about:blank";
    };
  }, [id, controlsRef]);
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl bg-black",
        vertical ? "aspect-[9/16]" : "aspect-video",
        className,
      )}
    >
      <iframe
        ref={frame}
        src="about:blank"
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
        className="absolute inset-0 size-full"
      />
    </div>
  );
}
