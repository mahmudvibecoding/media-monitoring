"use client";

import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { usePlayer } from "@/components/youtube-player";
import { ShareIcon, YT_ICON_BUTTON, YT_PILL } from "@/components/youtube-ui";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { videoLink } from "@/lib/youtube";

const TOAST_FOR = 3000; // milliseconds the "copied" message stays

// YouTube's Share button, and what it opens: the video's link on YouTube with a Copy button, and, for a video that has
// played a while, a box to have the link start where it's at. Copying closes it, and YouTube's dark message says the
// link is copied. With a look of its own (a round button with its label under it, as beside a Short), it's that.
export function ShareButton({
  id,
  short = false,
  look,
}: {
  id: string;
  short?: boolean;
  look?: (button: { open: () => void; label: string }) => ReactNode;
}) {
  const t = useTranslations("youtube");
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0); // the second the video had got to when the box opened
  const [fromThere, setFromThere] = useState(false);
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), TOAST_FOR);
    return () => clearTimeout(timer);
  }, [copied]);
  const link = videoLink(id, short, fromThere ? at : 0);

  function show() {
    setAt(Math.floor(player?.current?.position() ?? 0));
    setFromThere(false);
    setOpen(true);
  }

  // Through the clipboard's own interface, or, where the browser doesn't let the page at it, the old way, from the
  // field, selected (if that fails too, the link stays selected, for Ctrl+C)
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      field.current?.select();
      if (!document.execCommand("copy")) return;
    }
    setOpen(false);
    setCopied(true);
  }

  return (
    <>
      {look ? (
        look({ open: show, label: t("share") })
      ) : (
        <button type="button" onClick={show} className={cn(YT_PILL, "hover:bg-yt-chip-hover")}>
          <ShareIcon className="size-6" />
          {t("share")}
        </button>
      )}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(512px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-6 font-roboto text-yt-text shadow-[0_4px_32px_rgba(0,0,0,0.1)] outline-none">
            <div className="-mt-2 -mr-2 flex items-center justify-between">
              <Dialog.Title className="text-base leading-[22px]">{t("share")}</Dialog.Title>
              <Dialog.Close aria-label={t("close")} className={YT_ICON_BUTTON}>
                <XIcon className="size-6" />
              </Dialog.Close>
            </div>
            <div className="mt-6 flex items-center gap-3 rounded-xl border border-black/10 bg-[#f9f9f9] py-3 pr-3 pl-4">
              <input
                ref={field}
                readOnly
                value={link}
                aria-label={t("share")}
                onFocus={(event) => event.currentTarget.select()}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
              <button
                type="button"
                onClick={() => void copy()}
                className="h-9 shrink-0 rounded-full bg-yt-blue px-4 text-sm font-medium text-white hover:bg-[#0556bf]"
              >
                {t("copy")}
              </button>
            </div>
            {!short && at > 0 && (
              <label className="mt-6 flex w-fit cursor-pointer items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={fromThere}
                  onChange={(event) => setFromThere(event.target.checked)}
                  className="size-4 accent-yt-blue"
                />
                {t("startAt", { time: formatDuration(at) })}
              </label>
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      {copied && (
        <div
          role="status"
          className="fixed bottom-6 left-6 z-50 rounded-lg bg-[#0f0f0f] px-4 py-3.5 font-roboto text-sm text-white shadow-lg"
        >
          {t("copied")}
        </div>
      )}
    </>
  );
}
