// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SongLibrary } from "../src/SongLibrary";
import type { LibraryBook } from "../src/library";
import type { Song } from "../src/song";
import { fixtureLibrary } from "./fixtures/library";
import { WORKBOOK_PAGES } from "../src/workbook";

type LibraryProps = ComponentProps<typeof SongLibrary>;
const base = fixtureLibrary()[0];
const song = (
  id: string,
  title: string,
  composer: string | undefined,
  book: LibraryBook,
): Song => ({
  ...base,
  id,
  title,
  lesson: composer ? { ...base.lesson!, composer } : undefined,
  library: { book },
});
const songs = [
  song(
    "cadence-dancing-raindrops-v1",
    "Dancing Raindrops",
    "Émile Example",
    "recital-3",
  ),
  song("frere-jacques", "Frère Jacques", "Traditional", "recital-3"),
  song("jasmine-flower", "Jasmine Flower", "Traditional", "lesson-3"),
  song("my-waltz", "My Waltz", undefined, "recital-3"),
];
const fullPiano: Song = {
  ...song("an-jing", "安静 · 周杰伦", undefined, "lesson-3"),
  source: {
    composer: "周杰伦 · Jay Chou",
    description: "Full piano arrangement without suggested finger numbers.",
    url: "https://example.com/an-jing",
    credit: "Example arranger",
  },
};

let root: Root;
let container: HTMLDivElement;
let props: LibraryProps;
const search = () => container.querySelector<HTMLInputElement>("input")!;
const titles = () =>
  Array.from(
    container.querySelectorAll<HTMLButtonElement>(".song"),
    (button) => button.firstChild!.textContent,
  );
const groupToggle = (group: string) =>
  container.querySelector<HTMLButtonElement>(
    `[aria-controls="library-${group}"]`,
  )!;
const groupContent = (group: string) =>
  container.querySelector<HTMLDivElement>(`#library-${group}`)!;
async function render(overrides: Partial<LibraryProps> = {}) {
  props = { ...props, ...overrides };
  await act(async () => root.render(<SongLibrary {...props} />));
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function type(value: string) {
  await act(async () => {
    // Bypass React's value tracker to simulate a user edit.
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(search(), value);
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    songs,
    selected: songs[1].id,
    onSelect: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("song library", () => {
  it("shows George Bear’s Classes, one section per book, and the selected song", async () => {
    await render();
    expect(container.querySelector(".nav-label")?.textContent).toBe(
      "George Bear’s Classes 4",
    );
    expect(
      Array.from(
        container.querySelectorAll(".library-section-title"),
        (title) => title.textContent,
      ),
    ).toEqual([
      "Music for Little MozartsMusic Recital Book 3",
      "Music for Little MozartsMusic Lesson Book 3",
      "Piano SolosMovie Themes",
    ]);
    expect(titles()).toEqual([
      "Dancing Raindrops",
      "Frère Jacques",
      "My Waltz",
      "Jasmine Flower",
    ]);
    expect(
      container.querySelector(".song[aria-pressed=true]")?.textContent,
    ).toContain("Frère Jacques");
    expect(container.textContent).not.toContain("Import MIDI");
  });

  it("shows a book with no songs yet", async () => {
    await render({
      songs: songs.filter((s) => s.library?.book === "recital-3"),
    });
    expect(groupToggle("lesson-3").textContent).toMatch(/Lesson Book 3 *0$/);
    await click(groupToggle("lesson-3"));
    expect(groupContent("lesson-3").textContent).toBe(
      "No songs in this book yet.",
    );
  });

  it.each([
    ["  fReRe  ", ["Frère Jacques"]],
    ["ÉMILE", ["Dancing Raindrops"]],
    ["traditional", ["Frère Jacques", "Jasmine Flower"]],
    ["waltz", ["My Waltz"]],
  ])(
    "searches titles and composers without case or accent sensitivity: %s",
    async (term, expected) => {
      await render();
      await type(term);
      expect(titles()).toEqual(expected);
      expect(search().value).toBe(term);
    },
  );

  it("matches uppercase searches even when the browser defaults to Turkish casing", async () => {
    const nativeLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const localeLowerCase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(function (
        this: string,
        locales?: Parameters<typeof nativeLocaleLowerCase>[0],
      ) {
        return nativeLocaleLowerCase.call(this, locales ?? "tr");
      });
    try {
      const jingle = song(
        "jingle-bells",
        "Jingle Bells",
        "James Lord Pierpont",
        "recital-3",
      );
      await render({ songs: [jingle], selected: jingle.id });
      await type("JINGLE");
      expect(titles()).toEqual(["Jingle Bells"]);
    } finally {
      localeLowerCase.mockRestore();
    }
  });

  it.each(["  JAY CHOU  ", "周杰伦", "安静"])(
    "finds a full piano arrangement by its source composer or title: %s",
    async (term) => {
      await render({ songs: [...songs, fullPiano] });
      await type(term);
      expect(titles()).toEqual([fullPiano.title]);
      expect(search().value).toBe(term);
    },
  );

  it("labels source arrangements as full piano without suggesting finger numbers", async () => {
    await render({ songs: [fullPiano], selected: fullPiano.id });
    const button =
      groupContent("lesson-3").querySelector<HTMLButtonElement>(".song")!;
    expect(button.querySelector("small")?.textContent).toBe(
      "Full piano · No finger numbers",
    );
    expect(button.getAttribute("aria-pressed")).toBe("true");
    await click(button);
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(fullPiano);
  });

  it("keeps a matching source-composer search when revealing the selected arrangement", async () => {
    await render({ songs: [...songs, fullPiano] });
    await type("JAY CHOU");
    await click(groupToggle("lesson-3"));
    await render({ selected: fullPiano.id });
    expect(groupContent("lesson-3").hidden).toBe(false);
    expect(search().value).toBe("JAY CHOU");
    expect(titles()).toEqual([fullPiano.title]);
    expect(
      container.querySelector(".song[aria-pressed=true]")?.textContent,
    ).toContain(fullPiano.title);
  });

  it("clears an unrelated search when revealing a selected source arrangement", async () => {
    await render({ songs: [...songs, fullPiano] });
    await type("waltz");
    await click(groupToggle("lesson-3"));
    await render({ selected: fullPiano.id });
    expect(groupContent("lesson-3").hidden).toBe(false);
    expect(search().value).toBe("");
    expect(titles()).toContain(fullPiano.title);
  });

  it("keeps the startup-restored song folded, then reveals a later song change", async () => {
    await render({ selected: songs[2].id });
    expect(groupContent("lesson-3").hidden).toBe(true);
    expect(groupContent("recital-3").hidden).toBe(true);
    await render({ selected: songs[0].id });
    expect(groupContent("recital-3").hidden).toBe(false);
    expect(groupContent("lesson-3").hidden).toBe(true);
  });

  it("starts with books folded, toggles each one, and opens all when searching", async () => {
    await render();
    for (const group of ["recital-3", "lesson-3"]) {
      expect(groupToggle(group).getAttribute("aria-expanded")).toBe("false");
      expect(groupContent(group).hidden).toBe(true);
      await click(groupToggle(group));
      expect(groupToggle(group).getAttribute("aria-expanded")).toBe("true");
      expect(groupContent(group).hidden).toBe(false);
      await click(groupToggle(group));
      expect(groupContent(group).hidden).toBe(true);
    }
    await type("traditional");
    for (const group of ["recital-3", "lesson-3"]) {
      expect(groupToggle(group).getAttribute("aria-expanded")).toBe("true");
      expect(groupContent(group).hidden).toBe(false);
    }
    expect(titles()).toEqual(["Frère Jacques", "Jasmine Flower"]);
  });

  it("reveals an externally selected song even if its group and search hid it", async () => {
    await render();
    await type("frere");
    await click(groupToggle("lesson-3"));
    await render({ selected: songs[2].id });
    expect(groupContent("lesson-3").hidden).toBe(false);
    expect(search().value).toBe("");
    expect(titles()).toContain("Jasmine Flower");
    expect(
      container.querySelector(".song[aria-pressed=true]")?.textContent,
    ).toContain("Jasmine Flower");
  });

  it("keeps a search while typing or rerendering without a selection change", async () => {
    await render();
    await type("waltz");
    await render({ songs: [...songs] });
    expect(search().value).toBe("waltz");
    expect(titles()).toEqual(["My Waltz"]);
  });

  it("keeps a search when the next selected song matches it", async () => {
    await render();
    await type("traditional");
    await render({ selected: songs[2].id });
    expect(search().value).toBe("traditional");
    expect(titles()).toEqual(["Frère Jacques", "Jasmine Flower"]);
  });

  it("dispatches selection with the selected song object", async () => {
    await render();
    const raindrops = container.querySelector<HTMLButtonElement>(
      "#library-recital-3 .song",
    )!;
    await click(raindrops);
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(songs[0]);
  });

  it("shows search-specific empty results and restores songs after clearing", async () => {
    await render();
    await type("no such melody");
    expect(titles()).toEqual([]);
    const messages = Array.from(
      container.querySelectorAll(".library-empty"),
      (element) => element.textContent,
    );
    expect(messages).toEqual(Array(3).fill("No matches in this book."));
    await type("");
    expect(titles()).toHaveLength(songs.length);
  });

  it("shows an empty-library message", async () => {
    await render({ songs: [] });
    expect(titles()).toEqual([]);
    expect(
      Array.from(
        container.querySelectorAll(".library-empty"),
        (element) => element.textContent,
      ),
    ).toEqual(Array(3).fill("No songs in this book yet."));
  });

  it("lists Movie Themes last, outside the classes' count", async () => {
    const summer: Song = {
      ...fullPiano,
      id: "summer",
      title: "Summer · Kikujiro",
      source: { ...fullPiano.source!, composer: "Joe Hisaishi" },
      library: { book: "movies" },
    };
    await render({ songs: [...songs, summer], selected: "summer" });
    expect(container.querySelector(".nav-label")?.textContent).toBe(
      "George Bear’s Classes 4",
    );
    expect(groupToggle("movies").textContent).toMatch(/Movie Themes *1$/);
    expect(groupContent("movies").hidden).toBe(true);
    await type("hisaishi");
    expect(titles()).toEqual(["Summer · Kikujiro"]);
    expect(groupContent("movies").hidden).toBe(false);
  });
});

describe("Music Workbook 3", () => {
  const workbook = (selected: number | null = null) => ({
    pages: WORKBOOK_PAGES,
    selected,
    stamps: { 9: "2026-10-20" },
    onSelect: vi.fn(),
  });

  it("lists its pages after the class books, folded, with their stamps", async () => {
    const book = workbook();
    await render({ workbook: book });
    expect(
      Array.from(
        container.querySelectorAll(".library-section-title"),
        (title) => title.textContent,
      ).slice(-2),
    ).toEqual([
      "Music for Little MozartsMusic Workbook 3",
      "Piano SolosMovie Themes",
    ]);
    expect(groupContent("workbook-3").hidden).toBe(true);
    await click(groupToggle("workbook-3"));
    const pages = Array.from(
      groupContent("workbook-3").querySelectorAll<HTMLButtonElement>(".song"),
    );
    expect(pages.map((page) => page.firstChild!.textContent)).toEqual([
      "Page 4 · Middle C Position Review",
      "Page 5 · Left Hand and Right Hand",
      "Page 6 · Note Values",
      "Page 7 · Bass Clef C",
      "Page 8 · Middle C and Bass Clef C",
      "Page 9 · Bass Clef D",
      "Page 10 · Treble Clef D and Bass Clef D",
      "Page 11 · Bass Clef E",
      "Page 12 · Treble Clef E and Bass Clef E",
      "Page 13 · Steps, Skips and Repeats",
      "Page 14 · C Position for the Left Hand",
      "Page 15 · Staccato",
      "Page 16 · Rests",
      "Page 17 · Staccato",
      "Page 18 · Rhythm Patterns in 4/4 Time",
      "Page 19 · 2nds",
      "Page 20 · 2nds",
      "Page 21 · C Position",
      "Page 22 · Rhythm Patterns",
      "Page 23 · 3rds",
      "Page 24 · 3rds",
      "Page 25 · Melodies with 2nds and 3rds",
      "Page 26 · 2nds and 3rds",
      "Page 27 · Staccato and Legato Melodies",
      "Page 28 · Same and Different",
      "Page 29 · Left Hand and Right Hand",
      "Page 30 · C Position",
      "Page 31 · Harmonic Intervals",
      "Page 32 · Melodic Intervals",
      "Page 33 · Melodic and Harmonic Intervals",
      "Page 34 · Middle C Position",
      "Page 35 · Hands Together",
      "Page 36 · C, D, E, F and G",
      "Page 37 · C and E",
      "Page 38 · D and G",
      "Page 39 · 4ths",
      "Page 40 · 4ths",
      "Page 41 · 2nds, 3rds and 4ths",
      "Page 42 · F and G",
      "Page 43 · 5ths",
      "Page 44 · 5ths",
      "Page 45 · 4ths and 5ths",
      "Page 46 · Melodies with 2nds, 3rds, 4ths and 5ths",
      "Page 47 · Same and Different",
      "Page 48 · C Position and Middle C Position",
    ]);
    expect(pages[5].querySelector("small")!.textContent).toBe(
      "Crayon Keys · Done OCT 20 2026",
    );
    expect(pages[6].querySelector("small")!.textContent).toBe("Color by Note");
    await click(pages[5]);
    expect(book.onSelect).toHaveBeenCalledWith(9);
  });

  it("opens and marks the open page, with no song marked", async () => {
    await render({ workbook: workbook() });
    await render({ selected: "", workbook: workbook(10) });
    expect(groupContent("workbook-3").hidden).toBe(false);
    expect(
      Array.from(
        container.querySelectorAll(".song[aria-pressed=true]"),
        (b) => b.firstChild!.textContent,
      ),
    ).toEqual(["Page 10 · Treble Clef D and Bass Clef D"]);
  });

  it("finds pages by title when searching", async () => {
    await render({ workbook: workbook() });
    await type("clef d");
    expect(
      Array.from(
        groupContent("workbook-3").querySelectorAll(".song"),
        (b) => b.firstChild!.textContent,
      ),
    ).toEqual([
      "Page 9 · Bass Clef D",
      "Page 10 · Treble Clef D and Bass Clef D",
    ]);
  });
});
