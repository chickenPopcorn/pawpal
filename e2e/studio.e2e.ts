import type { Page } from "@playwright/test";
import { expect, test } from "./fake-supabase";

const songTitle = (page: Page) => page.getByRole("heading", { level: 1 });
const book = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(title) });
const song = (page: Page, title: string) =>
  page.getByRole("button", { name: new RegExp(`^${title}`) });
const mode = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Practice mode" })
    .getByRole("button", { name });
const time = (page: Page) => page.locator(".time");

test("the studio shows George Bear’s Classes from the library", async ({
  page,
}) => {
  await page.goto("/");

  await expect(page.getByText("George Bear’s Classes 2")).toBeVisible();
  // The first song of the first book opens; the books start folded.
  await expect(songTitle(page)).toHaveText(/Dancing Raindrops/);
  await expect(book(page, "Music Lesson Book 3")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await book(page, "Music Recital Book 3").click();
  await expect(song(page, "Dancing Raindrops")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Movie Themes comes after the class books, outside their count; songs
  // from other collections stay out of the studio.
  await book(page, "Movie Themes").click();
  await expect(song(page, "A Film Theme")).toBeVisible();
  await expect(page.getByText("Ode to Joy")).toHaveCount(0);

  // Only a signed-in request reads the MIDI file, so the page fetches it and
  // saves it under the song's id.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("button", { name: "Download Dancing Raindrops MIDI" })
      .click(),
  ]);
  expect(download.suggestedFilename()).toBe("cadence-dancing-raindrops-v1.mid");
  const saved = await download.createReadStream();
  const bytes: Buffer[] = [];
  for await (const chunk of saved) bytes.push(chunk as Buffer);
  expect(Buffer.concat(bytes).toString()).toBe("MThd");
  await expect(
    page.getByRole("region", { name: "Sheet music timeline" }),
  ).toBeVisible();
  await expect(time(page)).toHaveText("0:00 / 0:25");
});

test("searching finds a song in another book", async ({ page }) => {
  await page.goto("/");
  await expect(book(page, "Music Lesson Book 3")).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await page.getByRole("searchbox", { name: "Search songs" }).fill("o'clock");
  await expect(book(page, "Music Lesson Book 3")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(song(page, "Dancing Raindrops")).toBeHidden();
  await expect(
    page.locator("#library-recital-3").getByText("No matches in this book."),
  ).toBeVisible();

  await song(page, "Five O'Clock").click();
  await expect(songTitle(page)).toHaveText(/Five O'Clock/);
  await expect(
    page.getByText("Music Lesson Book 3", { exact: true }),
  ).toBeVisible();
});

test("the studio opens with the account's settings", async ({
  page,
  supabase,
}) => {
  supabase.settings = {
    mode: "rhythm",
    speed: 0.6,
    selected: "pawpal-five-oclock-v1",
    learnerName: "Georgie",
    learnerNameChosen: true,
  };
  await page.goto("/");

  await expect(songTitle(page)).toHaveText(/Five O'Clock/);
  await expect(mode(page, "Rhythm")).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("slider", { name: "Playback speed" }),
  ).toHaveValue("60");
  await expect(page.getByText("Georgie’s practice")).toBeVisible();
});

test("changed settings upload to the account", async ({ page, supabase }) => {
  await page.goto("/");
  await expect(mode(page, "Wait for me")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await mode(page, "Rhythm").click();
  await book(page, "Music Lesson Book 3").click();
  await song(page, "Five O'Clock").click();

  await expect
    .poll(() => supabase.settingsUploads.at(-1), { timeout: 10_000 })
    .toMatchObject({ mode: "rhythm", selected: "pawpal-five-oclock-v1" });
});

test("Listen plays the song and pauses", async ({ page }) => {
  await page.goto("/");
  await mode(page, "Listen").click();

  await page.getByRole("button", { name: "▷ Play" }).click();
  await expect(page.getByRole("button", { name: "Ⅱ Pause" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(time(page)).not.toHaveText(/^0:00 \//, { timeout: 10_000 });

  await page.getByRole("button", { name: "Ⅱ Pause" }).click();
  await expect(page.getByRole("button", { name: "▷ Play" })).toBeVisible();
  const paused = await time(page).textContent();
  await page.waitForTimeout(1500);
  await expect(time(page)).toHaveText(paused!);
});

test("the metronome counts in a bar before Rhythm plays", async ({
  page,
  supabase,
}) => {
  await page.goto("/");
  const metronome = page.getByRole("button", { name: "Metronome" });
  // Wait for me keeps no beat.
  await expect(metronome).toBeDisabled();
  await mode(page, "Rhythm").click();
  await metronome.click();
  await expect(metronome).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => supabase.settingsUploads.at(-1), { timeout: 10_000 })
    .toMatchObject({ click: true });

  await page.getByRole("button", { name: "▷ Play" }).click();
  await expect(page.getByRole("button", { name: "Ⅱ Pause" })).toBeVisible();
  // At 80 BPM the count-in takes over two seconds, and the song waits.
  await page.waitForTimeout(1500);
  await expect(time(page)).toHaveText(/^0:00 \//);
  await expect(time(page)).not.toHaveText(/^0:00 \//, { timeout: 10_000 });
});

test("Wait for me waits for the right key", async ({ page, supabase }) => {
  await page.goto("/");
  const review = page.getByRole("region", { name: "Practice review" });
  const matched = review.locator(".stats > div", { hasText: "Matched" });
  await expect(mode(page, "Wait for me")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "▷ Play" }).click();
  await expect(page.getByRole("button", { name: "Ⅱ Pause" })).toBeVisible();
  // Dancing Raindrops starts on G3, the B key. A wrong key counts once the
  // count-in reaches that note, and never moves the song on.
  await expect(async () => {
    await page.keyboard.press("z");
    await expect(review).toContainText(/[1-9]\d* wrong presses/, {
      timeout: 250,
    });
  }).toPass({ timeout: 15_000 });
  await expect(matched).toContainText("0");

  await page.keyboard.press("b");
  await expect(matched).toContainText("1");
  await expect(review).toContainText("That’s it. Keep going.");

  // Practice saves the song's progress to the account.
  await page.getByRole("button", { name: "Ⅱ Pause" }).click();
  await expect
    .poll(() => supabase.progress.get("cadence-dancing-raindrops-v1"), {
      timeout: 10_000,
    })
    .toMatchObject({ attempts: 1 });
});
