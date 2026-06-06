import { expect, test } from "@playwright/test";

const email = process.env.PLAYWRIGHT_AUTH_EMAIL;
const password = process.env.PLAYWRIGHT_AUTH_PASSWORD;

test.skip(!email || !password, "Set PLAYWRIGHT_AUTH_EMAIL/PASSWORD for owner flow e2e.");

test("authenticated owner can reach dashboard and recent outreach controls", async ({ page }) => {
  await page.goto("/login?redirect=/dashboard");
  await page.getByPlaceholder("you@company.com").fill(email!);
  await page.getByPlaceholder("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Organization" })).toBeVisible();

  await page.goto("/recent");
  await expect(page.getByRole("heading", { name: "Recent AEO audits" })).toBeVisible();

  const outreachSummary = page.getByText("Send outreach").first();
  if ((await outreachSummary.count()) === 0) return;

  await outreachSummary.click();
  await expect(page.getByRole("button", { name: "Social" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Social" }).first().click();
  await expect(page.getByRole("button", { name: /Record SOCIAL|Post SOCIAL/ }).first()).toBeVisible();
});
