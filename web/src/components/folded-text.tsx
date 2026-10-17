"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LINE_CLAMPS = { 3: "line-clamp-3", 6: "line-clamp-6" } as const; // written out, so Tailwind finds them

// A text kept to a few lines, a description or a long comment, with a button for the rest. Whether it's longer is told
// by its length and its line breaks, which the server knows too, so the page doesn't shift once it's in the browser.
export function FoldedText({ text, lines, className }: { text: string; lines: 3 | 6; className?: string }) {
  const t = useTranslations("common");
  const [open, setOpen] = useState(false);
  const long = text.length > lines * 80 || text.split("\n").length > lines;
  return (
    <div className="space-y-1">
      <p className={cn("break-words whitespace-pre-line", long && !open && LINE_CLAMPS[lines], className)}>{text}</p>
      {long && (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setOpen(!open)}>
          {open ? t("less") : t("more")}
        </Button>
      )}
    </div>
  );
}
