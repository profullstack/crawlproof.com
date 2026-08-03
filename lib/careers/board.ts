// Server-side loader for the hosted job board (/c/<project_id>). Shared by the
// board page and the individual posting page, and kept out of page.tsx because
// Next only allows its own named exports there.

import { serviceClient } from "@/lib/supabase/service";
import type { PublicJob } from "@/lib/careers/jobs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BoardProject {
  id: string;
  name: string;
  url: string;
}

export interface Board {
  project: BoardProject;
  jobs: PublicJob[];
}

/**
 * Open roles for a project, or null when the project doesn't exist or has the
 * careers module switched off. Uses the service role plus the
 * public_job_postings function, which enforces both feature flags itself.
 */
export async function loadBoard(projectId: string): Promise<Board | null> {
  if (!UUID.test(projectId)) return null;
  const supabase = serviceClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, url, careers_enabled, tracker_enabled")
    .eq("id", projectId)
    .maybeSingle();
  if (!project || !project.careers_enabled || !project.tracker_enabled) return null;

  const { data } = await supabase.rpc("public_job_postings", {
    p_project_id: projectId,
  });

  const jobs = ((data ?? []) as PublicJob[]).map((job) => ({
    ...job,
    responsibilities: job.responsibilities ?? [],
    qualifications: job.qualifications ?? [],
  }));

  return {
    project: project as BoardProject,
    jobs,
  };
}

/** Hostname for display, tolerant of a malformed project URL. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
