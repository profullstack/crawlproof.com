// Notification for a new job application.
//
// Without this, applications land in the dashboard silently and the employer
// has to think to go and look — which, for a hiring inbox, means good
// candidates go stale. Best-effort throughout: a mail failure must never turn
// a successfully-recorded application into an error for the applicant.

import { env } from "@/lib/env";
import { sendCareersApplicationEmail } from "@/lib/email";
import { serviceClient } from "@/lib/supabase/service";

export interface ApplicationNotice {
  projectId: string;
  jobTitle: string;
  fullName: string;
  email: string;
  link: string | null;
}

/**
 * Email the project owner that someone applied.
 *
 * Resolves the recipient from the project owner's profile. Returns quietly if
 * mail isn't configured, the owner has no address, or the send fails — the
 * caller has already written the row and the applicant is already done.
 */
export async function notifyNewApplication(notice: ApplicationNotice): Promise<void> {
  try {
    const supabase = serviceClient();
    const { data: project } = await supabase
      .from("projects")
      .select("name, owner_id")
      .eq("id", notice.projectId)
      .maybeSingle();
    const ownerId = (project as { owner_id?: string } | null)?.owner_id;
    if (!ownerId) return;

    const { data: profile } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", ownerId)
      .maybeSingle();
    const to = (profile as { email?: string | null } | null)?.email;
    if (!to) return;

    await sendCareersApplicationEmail({
      to,
      projectName: (project as { name?: string } | null)?.name ?? "your site",
      jobTitle: notice.jobTitle,
      applicantName: notice.fullName,
      applicantEmail: notice.email,
      link: notice.link,
      inboxUrl: `${env.siteUrl.replace(/\/+$/, "")}/projects/${notice.projectId}/stats/careers`,
    });
  } catch {
    // Swallowed on purpose — see the module comment.
  }
}
