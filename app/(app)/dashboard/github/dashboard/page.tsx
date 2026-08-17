import { redirect } from "next/navigation";

export const metadata = {
  title: "GitHub dashboard",
};

export default function GithubDashboardPage() {
  redirect("/dashboard/settings/integrations/github");
}
