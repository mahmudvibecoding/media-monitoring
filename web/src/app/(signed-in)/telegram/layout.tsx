import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { telegramChannelsInfiniteOptions } from "@/api/@tanstack/react-query.gen";
import { TelegramFrame } from "@/components/telegram-frame";
import { serverClient, signedInUser } from "@/lib/api-server";
import { FIRST_PAGE } from "@/lib/pages";
import { getQueryClient } from "@/lib/query-client";
import { channelsQuery, platformOf } from "@/lib/telegram";

// Telegram's pages here, laid out as Telegram Web looks on the visitor's device: the chat list at the left, which
// arrives with the page (its first folder's first channels) and stays as one goes from one chat to another. Only admins
// see them (each page says so): anyone else gets the page alone.
export default async function TelegramLayout({ children }: { children: ReactNode }) {
  const user = await signedInUser();
  if (user?.role !== "admin") return children;
  const platform = platformOf((await headers()).get("user-agent") ?? "");
  const queryClient = getQueryClient();
  await queryClient.prefetchInfiniteQuery({
    ...telegramChannelsInfiniteOptions({ client: serverClient, query: channelsQuery("subscribers", "") }),
    ...FIRST_PAGE,
  });
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TelegramFrame platform={platform}>{children}</TelegramFrame>
    </HydrationBoundary>
  );
}
