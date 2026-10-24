import type { DisagreementsData } from "@/api/types.gen";
import { addressOf, pageOf } from "@/lib/address";

export type DisagreementsQuery = NonNullable<DisagreementsData["query"]>;
export type Platform = NonNullable<DisagreementsQuery["platform"]>;
export type Difference = NonNullable<DisagreementsQuery["difference"]>;
export const PLATFORMS: Platform[] = ["telegram", "youtube_video", "youtube_short", "youtube_comment"];
export const DIFFERENCES: Difference[] = ["missed", "extra", "kind", "part"];

// The disagreements' choices, from the page's address: whose names (?source=claude; Gemma's by default), where the
// texts are from (?platform=…), the kind of difference (?difference=…) and the page; only what isn't the default, so
// the server and the browser build the same query
export function disagreementsQuery(params: URLSearchParams): DisagreementsQuery {
  const query: DisagreementsQuery = {};
  if (params.get("source") === "claude") query.source = "claude";
  const platform = PLATFORMS.find((p) => p === params.get("platform"));
  if (platform) query.platform = platform;
  const difference = DIFFERENCES.find((d) => d === params.get("difference"));
  if (difference) query.difference = difference;
  const page = pageOf(params);
  if (page) query.page = page;
  return query;
}

export const disagreementsAddress = (query: DisagreementsQuery) =>
  addressOf({
    source: query.source,
    platform: query.platform ?? undefined,
    difference: query.difference ?? undefined,
    page: query.page,
  });
