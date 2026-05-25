import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ProjectLayoutClient } from "./layout-client";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, url, logo_url, schedule, status, engines")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  return (
    <ProjectLayoutClient
      projectId={project.id}
      name={project.name}
      url={project.url}
      logoUrl={project.logo_url ?? null}
      schedule={project.schedule}
      status={project.status ?? "active"}
      engines={project.engines ?? ["rule"]}
    >
      {children}
    </ProjectLayoutClient>
  );
}
