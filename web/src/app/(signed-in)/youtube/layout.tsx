import { type ReactNode, Suspense } from "react";

import { YouTubeMasthead } from "@/components/youtube-masthead";
import { signedInUser } from "@/lib/api-server";

// YouTube's pages here, in YouTube's font and colors, under YouTube's top bar, which stays as one goes from one of them
// to another, as on YouTube. Only admins see them (each page says so): anyone else gets the page alone.
export default async function YouTubeLayout({ children }: { children: ReactNode }) {
  const user = await signedInUser();
  if (user?.role !== "admin") return children;
  return (
    <div className="font-roboto text-yt-text">
      <Suspense fallback={<div className="sticky top-0 z-30 h-14 bg-white" />}>
        <YouTubeMasthead />
      </Suspense>
      {children}
    </div>
  );
}
