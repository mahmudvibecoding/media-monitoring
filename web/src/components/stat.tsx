import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

// Numbers side by side, divided by thin lines: a <dl> of Stat, its columns given by className (as many as fill the
// rows, since an empty place would show the lines' color)
export function Stats({ className, children }: { className?: string; children: ReactNode }) {
  return <dl className={cn("grid gap-px overflow-hidden rounded-lg border bg-border", className)}>{children}</dl>;
}

// One of them: its name, with an icon if it has one, the number, and maybe a note below; or, with iconOnly, the icon
// beside the number, the name on hover (and for screen readers)
export function Stat({
  label,
  value,
  note,
  icon: Icon,
  iconOnly = false,
}: {
  label: string;
  value: ReactNode;
  note?: string;
  icon?: ComponentType<{ className?: string }>;
  iconOnly?: boolean;
}) {
  if (iconOnly && Icon) {
    return (
      <div className="bg-background px-4 py-3" title={label}>
        <dt className="sr-only">{label}</dt>
        <dd className="flex items-center gap-2.5 text-xl font-semibold tracking-tight tabular-nums">
          <Icon className="size-5 shrink-0 text-muted-foreground" />
          {value}
        </dd>
      </div>
    );
  }
  return (
    <div className="bg-background px-4 py-3">
      <dt className="flex items-center gap-1.5 leading-tight text-muted-foreground">
        {Icon && <Icon className="size-3.5 shrink-0" />}
        <span>{label}</span>
      </dt>
      <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</dd>
      {note && <dd className="text-xs text-muted-foreground">{note}</dd>}
    </div>
  );
}
