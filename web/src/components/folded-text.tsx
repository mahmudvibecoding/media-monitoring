"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LINE_CLAMPS = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  6: "line-clamp-6",
} as const; // written out, so Tailwind finds them

// A text kept to a few lines, a description or a long comment, with a button for the rest (styled by buttonClassName,
// as each site has its own). Whether it's longer is told by its length and its line breaks, which the server knows
// too, so the page doesn't shift once it's in the browser.
export function FoldedText({
  text,
  lines,
  className,
  buttonClassName,
}: {
  text: string;
  lines: keyof typeof LINE_CLAMPS;
  className?: string;
  buttonClassName?: string;
}) {
  const t = useTranslations("common");
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 80 || text.split("\n").length > lines;
  return (
    <div className="space-y-1">
      <p className={cn("break-words whitespace-pre-line", long && !open && LINE_CLAMPS[lines], className)}>{text}</p>
      {long && (
        <Button variant="link" size="sm" className={cn("h-auto px-0", buttonClassName)} onClick={() => setOpen(!open)}>
          {open ? t("less") : t("more")}
        </Button>
      )}
    </div>
  );
}
