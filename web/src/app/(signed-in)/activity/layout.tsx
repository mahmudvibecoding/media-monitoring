import type { ReactNode } from "react";

import { EnglishOnly } from "@/components/english-only";

// The activity's pages are in English, whatever the visitor's language
export default function ActivityLayout({ children }: { children: ReactNode }) {
  return <EnglishOnly>{children}</EnglishOnly>;
}
