import { expect, test } from "./fake-supabase";

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Google sign-in opens the learner's studio", async ({
    page,
    supabase,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Paw Pal" })).toBeVisible();
    await expect(
      page.getByText("Sign in to keep your practice progress on every device."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Continue with Google" }).click();

    // The studio opens once supabase-js has traded the code for a session.
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(supabase.authorizations).toHaveLength(1);
    const [authorize] = supabase.authorizations;
    expect(authorize.searchParams.get("provider")).toBe("google");
    expect(authorize.searchParams.get("redirect_to")).toBe(
      new URL("/", page.url()).href,
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("s256");
    // The code leaves the address bar, and the name comes from Google.
    await expect(page).not.toHaveURL(/code=/);
    await expect(page.getByText("George’s practice")).toBeVisible();
  });
});

test("Sign out returns to the sign-in page", async ({ page, supabase }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  expect(supabase.signOuts).toBe(1);

  // Signed out for good: a reload does not reopen the studio.
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
});

test("the calendar shows practice the account keeps from another device", async ({
  page,
  supabase,
}) => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  supabase.practice.set("00000000-0000-4000-8000-0000000000a1", {
    id: "00000000-0000-4000-8000-0000000000a1",
    day: today,
    started_at: `${today}T12:00:00.000Z`,
    seconds: 300,
    songs: { "cadence-dancing-raindrops-v1": 300 },
  });
  await page.goto("/");
  await expect(
    page.getByRole("listitem", { name: /today: 5 minutes, star earned/ }),
  ).toBeVisible();

  // The account keeps it, so signing out clears this browser's copy.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("button", { name: "Continue with Google" }),
  ).toBeVisible();
  const kept = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.includes("practice:")),
  );
  expect(kept).toEqual([]);
});
