import { notFound } from "next/navigation";
import { listProjectTeam } from "@/app/actions/project-members";
import { MembersClient } from "./members-client";

export default async function ProjectMembersPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await listProjectTeam(id);
  if (!result.ok) notFound();

  return (
    <MembersClient
      projectId={id}
      isOwner={result.isOwner}
      members={result.members}
      invitations={result.invitations}
    />
  );
}
