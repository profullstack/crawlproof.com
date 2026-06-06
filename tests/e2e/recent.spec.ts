import { expect, test } from "@playwright/test";

test("recent scans page renders publicly without outreach controls", async ({ page }) => {
  await page.goto("/recent");

  await expect(page.getByRole("heading", { name: "Recent AEO audits" })).toBeVisible();
  await expect(
    page.getByText("only scans explicitly listed by the submitter appear here"),
  ).toBeVisible();
  await expect(page.getByText("Send outreach")).toHaveCount(0);
});
