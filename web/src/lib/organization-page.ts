import { cache } from "react";

import { organizationDetails, projectDetails } from "@/api/sdk.gen";
import { serverClient } from "@/lib/api-server";

// A number in a Users page's address: an organization's or a project's ID, or null when it isn't one
export function idOf(given: string): number | null {
  return /^\d{1,15}$/.test(given) ? Number(given) : null;
}

// The organization of a Users page, asked for once per page load though both the tab's title and the page need it:
// null when there's no such organization (or the address has no number for one), undefined when the API didn't say
// (the browser then asks again, and shows why if it fails again)
export const loadOrganization = cache(async (id: number | null) => {
  if (id === null) return null;
  const { data, response } = await organizationDetails({ client: serverClient, path: { organization_id: id } });
  if (data) return data;
  return response?.status === 404 || response?.status === 422 ? null : undefined;
});

// A project's page's project, in the same way
export const loadProject = cache(async (id: number | null) => {
  if (id === null) return null;
  const { data, response } = await projectDetails({ client: serverClient, path: { project_id: id } });
  if (data) return data;
  return response?.status === 404 || response?.status === 422 ? null : undefined;
});
