import { expect, test } from "@playwright/test";

const email = process.env.PLAYWRIGHT_AUTH_EMAIL ?? "anthony+riotcoder@profullstack.com";
const password = process.env.PLAYWRIGHT_AUTH_PASSWORD;
const projectId = process.env.PLAYWRIGHT_AUTOBLOG_PROJECT_ID;

test("autoblog content plan requires authentication", async ({ page }) => {
  await page.goto("/projects/example-project/autoblog/plan");
  await expect(page).toHaveURL(/\/login/);
});

test("authenticated owner can open the autoblog content plan", async ({ page }) => {
  test.skip(
    !password || !projectId,
    "Set PLAYWRIGHT_AUTH_PASSWORD and PLAYWRIGHT_AUTOBLOG_PROJECT_ID for content-plan e2e.",
  );

  await page.goto(`/login?redirect=/projects/${projectId}/autoblog/plan`);
  await page.getByPlaceholder("you@company.com").fill(email);
  await page.getByPlaceholder("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Content plan" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "30-day queue" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "href",
    `/projects/${projectId}/autoblog`,
  );
});

