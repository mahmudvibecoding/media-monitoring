import type { Run, RunsData } from "@/api/types.gen";
import { addressOf, pageOf } from "@/lib/address";

export type RunsQuery = NonNullable<RunsData["query"]>;
export type Step = NonNullable<RunsQuery["step"]>;

// Every step a run can be, in a round's order
export const STEPS: Step[] = [
  "round",
  "proxies",
  "youtube channels",
  "youtube videos",
  "youtube details",
  "youtube stats",
  "youtube comments",
  "telegram channels",
  "telegram messages",
];

// The activity's address: one step's runs alone, and the page (?step=youtube+comments&page=2)
export function runsQuery(params: URLSearchParams): RunsQuery {
  const query: RunsQuery = {};
  const step = STEPS.find((name) => name === params.get("step"));
  if (step) query.step = step;
  const page = pageOf(params);
  if (page) query.page = page;
  return query;
}

export function runsAddress(query: RunsQuery): string {
  return addressOf({ step: query.step ?? undefined, page: query.page });
}

// A number a run counted, by its name, or by its group's name and its own (numbers.vpn.unique): undefined if there's
// none
export function numberOf(numbers: Record<string, unknown>, ...path: string[]): number | undefined {
  let value: unknown = numbers;
  for (const key of path) {
    value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  }
  return typeof value === "number" ? value : undefined;
}

// A group of counts a run kept (numbers.requests: {"ok": 228240, "gone": 3632}), the biggest first
export function countsOf(numbers: Record<string, unknown>, ...path: string[]): [string, number][] {
  let value: unknown = numbers;
  for (const key of path) {
    value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, b) => b[1] - a[1]);
}

// How long a run took, or has been going: to its end, or to the last time it (or, for a round, one of its steps) said
// anything. Not to the browser's clock, so the server and the browser show the same.
export function secondsOf(run: Run & { steps?: Run[] }): number {
  const ends = [
    run.finished_at ?? run.updated_at,
    ...(run.steps ?? []).map((step) => step.finished_at ?? step.updated_at),
  ];
  const end = run.finished_at ? Date.parse(run.finished_at) : Math.max(...ends.map((when) => Date.parse(when)));
  return Math.max(0, (end - Date.parse(run.started_at)) / 1000);
}

// Whether any of these runs, or their steps, is still going: then the page asks again every few seconds
export function anyRunning(runs: (Run & { steps?: Run[] })[]): boolean {
  return runs.some((run) => run.outcome === "running" || (run.steps ?? []).some((step) => step.outcome === "running"));
}
