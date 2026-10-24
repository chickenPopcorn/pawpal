import { describe, expect, it, vi } from "vitest";
import {
  BOOK_IDS,
  loadLibrary,
  validateIndex,
  validateSong,
} from "../src/library";
import { bookForSong, books } from "../src/books";
import data from "./fixtures/library-songs.json";
import type { Song } from "../src/song";

const fixtures = data as unknown as { collection: string; song: Song }[];
const ode = () => structuredClone(fixtures[0].song);
const index = () => ({
  version: 1,
  songs: fixtures.map(({ collection, song }) => ({
    id: song.id,
    title: song.title,
    collection,
    // Published names carry each file's content hash.
    song: `songs/${song.id}.0123456789abcdef.json`,
    midi: `songs/${song.id}.fedcba9876543210.mid`,
  })),
});
const url = (path: string) => `https://cdn.example/library/${path}`;

describe("song library", () => {
  it("accepts the library index and the app's song format", () => {
    expect(validateIndex(index()).songs).toHaveLength(3);
    for (const { song } of fixtures)
      expect(validateSong(structuredClone(song), song.id).id).toBe(song.id);
  });

  it.each([
    [{ version: 2, songs: [] }, /version: 1/],
    [{ version: 1, songs: [] }, /no songs/],
    [{ ...index(), songs: [index().songs[0], index().songs[0]] }, /duplicate/],
    [
      { version: 1, songs: [{ ...index().songs[0], collection: "jazz" }] },
      /collection must be one of/,
    ],
    [
      { version: 1, songs: [{ ...index().songs[0], book: "primer-1" }] },
      /book must be one of/,
    ],
    [
      { version: 1, songs: [{ ...index().songs[0], id: "../escape" }] },
      /id must use/,
    ],
    [
      {
        version: 1,
        songs: [{ ...index().songs[0], song: "../src/library.ts" }],
      },
      /song must be songs/,
    ],
    [
      {
        version: 1,
        songs: [
          { ...index().songs[0], midi: `songs/${index().songs[1].id}.mid` },
        ],
      },
      /midi must be songs/,
    ],
  ])("rejects a broken index %#", (value, problem) => {
    expect(() => validateIndex(value)).toThrow(problem);
  });

  it.each([
    ["the wrong id", (song: Song) => ({ ...song, id: "other" }), /its id/],
    ["no notes", (song: Song) => ({ ...song, notes: [] }), /missing notes/],
    [
      "a note on a missing track",
      (song: Song) => ({
        ...song,
        notes: [{ ...song.notes[0], track: 99 }],
      }),
      /bad note/,
    ],
    [
      "an out-of-range pitch",
      (song: Song) => ({
        ...song,
        notes: [{ ...song.notes[0], pitch: 200 }],
      }),
      /bad note/,
    ],
    ["no duration", (song: Song) => ({ ...song, duration: 0 }), /duration/],
    [
      "two notes with one id",
      (song: Song) => ({
        ...song,
        notes: [song.notes[0], { ...song.notes[1], id: song.notes[0].id }],
      }),
      /duplicate note id/,
    ],
    [
      "a tempo of zero",
      (song: Song) => ({
        ...song,
        tempos: [{ tick: 0, microseconds: 0 }],
      }),
      /microseconds > 0/,
    ],
    [
      "a warning that is not text",
      (song: Song) => ({ ...song, warnings: [{}] as never }),
      /warnings must be a list of text/,
    ],
    [
      "a lesson without its text",
      (song: Song) => ({
        ...song,
        lesson: { ...song.lesson!, composer: 5 as never },
      }),
      /lesson needs/,
    ],
    [
      "a finger outside 1 to 5",
      (song: Song) => ({
        ...song,
        notes: [{ ...song.notes[0], finger: 9 as never }],
      }),
      /bad note/,
    ],
    [
      "a time signature over 3",
      (song: Song) => ({
        ...song,
        timeSignatures: [{ tick: 0, numerator: 4, denominator: 3 }],
      }),
      /denominator a power of two/,
    ],
    [
      "a time signature past the score's last tick",
      (song: Song) => ({
        ...song,
        timeSignatures: [{ tick: 2 ** 40 + 1, numerator: 3, denominator: 4 }],
      }),
      /denominator a power of two/,
    ],
    [
      "a note written with a negative length",
      (song: Song) => ({
        ...song,
        notes: [{ ...song.notes[0], notatedBeats: -2 }],
      }),
      /bad note/,
    ],
    [
      "a silent note",
      (song: Song) => ({
        ...song,
        notes: [{ ...song.notes[0], velocity: 0 }],
      }),
      /bad note/,
    ],
    [
      "a note that ends before it starts",
      (song: Song) => ({
        ...song,
        notes: [{ ...song.notes[0], end: song.notes[0].start - 0.1 }],
      }),
      /bad note/,
    ],
    [
      "a note that starts after the song ends",
      (song: Song) => ({
        ...song,
        notes: [
          {
            ...song.notes[0],
            start: song.duration,
            end: song.duration,
            soundEnd: song.duration,
          },
        ],
      }),
      /bad note/,
    ],
    [
      "a note that sounds past the song's end",
      (song: Song) => ({
        ...song,
        notes: [{ ...song.notes[0], soundEnd: song.duration + 1 }],
      }),
      /bad note/,
    ],
    [
      "a track count that does not match its notes",
      (song: Song) => ({
        ...song,
        tracks: song.tracks.map((track, i) =>
          i ? track : { ...track, count: 0 },
        ),
      }),
      /count is 0/,
    ],
    [
      "a null pedal list",
      (song: Song) => ({ ...song, pedals: null as never }),
      /pedals must be a list/,
    ],
    [
      "a pedal that lifts before it presses",
      (song: Song) => ({
        ...song,
        pedals: [{ channel: 0, start: 2, end: 1 }],
      }),
      /pedals must be a list/,
    ],
    [
      "a pedal past the song's end",
      (song: Song) => ({
        ...song,
        pedals: [{ channel: 0, start: 0, end: song.duration + 1 }],
      }),
      /pedals must be a list/,
    ],
    [
      "a pedal whose open flag is not true",
      (song: Song) => ({
        ...song,
        pedals: [{ channel: 0, start: 0, end: 1, open: "false" as never }],
      }),
      /pedals must be a list/,
    ],
    [
      "a note released under the pedal that stops early",
      (song: Song) => ({
        ...song,
        pedals: [
          {
            channel: song.notes[0].channel,
            start: song.notes[0].start,
            end: song.notes[0].end + 0.5,
          },
        ],
        notes: [{ ...song.notes[0], soundEnd: song.notes[0].end }],
      }),
      /stops before the pedal/,
    ],
    [
      "more than 256 tracks",
      (song: Song) => ({
        ...song,
        tracks: [
          ...song.tracks,
          ...Array.from({ length: 256 }, (_, i) => ({
            id: 1000 + i,
            name: "",
            hand: "off" as const,
            count: 0,
          })),
        ],
      }),
      /more than 256 tracks/,
    ],
    [
      "a pedal after one left down at the end",
      (song: Song) => ({
        ...song,
        pedals: [
          { channel: 0, start: 0, end: 1, open: true },
          { channel: 0, start: 2, end: 3 },
        ],
      }),
      /without overlaps/,
    ],
    [
      "overlapping pedals on one channel",
      (song: Song) => ({
        ...song,
        pedals: [
          { channel: 0, start: 0, end: 2 },
          { channel: 0, start: 1, end: 1.5 },
        ],
      }),
      /without overlaps/,
    ],
    [
      "no beats in a bar",
      (song: Song) => ({ ...song, beatsPerBar: 0 }),
      /beatsPerBar must be a positive number/,
    ],
    [
      "a negative lead-in",
      (song: Song) => ({ ...song, leadInBeats: -1 }),
      /leadInBeats must be zero or more/,
    ],
    [
      "pedals out of order",
      (song: Song) => ({
        ...song,
        pedals: [
          { channel: 0, start: 2, end: 3 },
          { channel: 0, start: 0, end: 1 },
        ],
      }),
      /start order/,
    ],
    [
      "two tracks with one id",
      (song: Song) => ({ ...song, tracks: [song.tracks[0], song.tracks[0]] }),
      /duplicate track id/,
    ],
  ])("rejects a song with %s", (_, change, problem) => {
    expect(() => validateSong(change(ode()), ode().id)).toThrow(problem);
  });

  // Five O'Clock's teacher duet is printed two octaves below the student part.
  const fiveOClock = () => structuredClone(fixtures[2].song);
  const withDuetNote = (song: Song, change: object) => ({
    ...song,
    duet: {
      ...song.duet!,
      notes: [{ ...song.duet!.notes[0], ...change }, ...song.duet!.notes],
    },
  });
  it.each([
    [
      "a duet three octaves away",
      (song: Song) => ({ ...song, duet: { ...song.duet!, octaves: 3 } }),
      /duet needs octaves/,
    ],
    [
      "an empty duet",
      (song: Song) => ({ ...song, duet: { ...song.duet!, notes: [] } }),
      /duet needs octaves/,
    ],
    [
      "a duet note on a student track",
      (song: Song) => withDuetNote(song, { id: "extra", track: 0 }),
      /bad duet note extra/,
    ],
    [
      "a fingered duet note",
      (song: Song) => withDuetNote(song, { id: "extra", finger: 1 }),
      /bad duet note extra/,
    ],
    [
      "a duet note sounding past the end",
      (song: Song) =>
        withDuetNote(song, { id: "extra", soundEnd: song.duration + 1 }),
      /bad duet note extra/,
    ],
    [
      "a duet note sharing a student note's id",
      (song: Song) => withDuetNote(song, { id: song.notes[0].id }),
      /duplicate note id/,
    ],
    [
      "a student part the duet moves off the keyboard",
      (song: Song) => ({
        ...song,
        notes: [{ ...song.notes[0], pitch: 120 }, ...song.notes.slice(1)],
      }),
      /leaves the keyboard with the duet/,
    ],
  ])("rejects a song with %s", (_, change, problem) => {
    expect(fiveOClock().duet!.octaves).toBe(2);
    expect(() => validateSong(change(fiveOClock()), fiveOClock().id)).toThrow(
      problem,
    );
  });

  it("loads only George Bear’s Classes, each song with its book and download", async () => {
    const classes = index();
    // Five O'Clock names its book; Dancing Raindrops does not.
    Object.assign(classes.songs[2], { book: "lesson-3" });
    const files = new Map<string, unknown>([
      [url("index.json"), classes],
      ...fixtures.map(
        ({ song }) =>
          [url(`songs/${song.id}.0123456789abcdef.json`), song] as const,
      ),
    ]);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const body = files.get(String(input));
      return new Response(JSON.stringify(body), {
        status: body ? 200 : 404,
      });
    });
    const songs = await loadLibrary(url, fetcher as typeof fetch);
    // Ode to Joy is in another collection, so it is not even downloaded.
    expect(fixtures[0].collection).toBe("songs");
    expect(songs.map((song) => song.id)).toEqual([
      fixtures[1].song.id,
      fixtures[2].song.id,
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(songs[0].library).toEqual({
      book: "recital-3",
      midi: url(`songs/${fixtures[1].song.id}.fedcba9876543210.mid`),
    });
    expect(songs.map((song) => bookForSong(song).id)).toEqual([
      "recital-3",
      "lesson-3",
    ]);
    // The index is always revalidated. Hashed song files use the browser's
    // normal cache, which keeps them for the year the bucket allows.
    expect(fetcher).toHaveBeenCalledWith(
      url("index.json"),
      expect.objectContaining({ cache: "no-cache" }),
    );
    const songCall = fetcher.mock.calls.find(([input]) =>
      String(input).endsWith(".0123456789abcdef.json"),
    ) as unknown as [string, RequestInit];
    expect(songCall[1].cache).toBeUndefined();
  });

  it("loads Movie Themes as one book", async () => {
    const movies = index();
    // Ode to Joy stands in for a movie theme.
    movies.songs[0].collection = "movies";
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const id = /songs\/(.+)\.0123456789abcdef\.json$/.exec(
        String(input),
      )?.[1];
      return new Response(
        JSON.stringify(
          id ? fixtures.find(({ song }) => song.id === id)?.song : movies,
        ),
      );
    });
    const songs = await loadLibrary(url, fetcher as typeof fetch);
    expect(songs.map((song) => [song.id, bookForSong(song).id])).toEqual([
      [fixtures[0].song.id, "movies"],
      [fixtures[1].song.id, "recital-3"],
      [fixtures[2].song.id, "recital-3"],
    ]);
  });

  it("fails clearly when George Bear’s Classes has no songs", async () => {
    const others = index();
    for (const entry of others.songs) entry.collection = "songs";
    // Movie Themes alone is not enough.
    others.songs[0].collection = "movies";
    const fetcher = vi.fn(async () => new Response(JSON.stringify(others)));
    await expect(loadLibrary(url, fetcher as typeof fetch)).rejects.toThrow(
      /George Bear’s Classes has no songs/,
    );
  });

  it("fails clearly when a song file is missing", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      String(input) === url("index.json")
        ? new Response(JSON.stringify(index()))
        : new Response("", { status: 404 }),
    );
    await expect(loadLibrary(url, fetcher as typeof fetch)).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it("gives up on a library file that does not answer", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      );
      const loading = loadLibrary(url, fetcher as typeof fetch);
      const failure = expect(loading).rejects.toThrow(
        /no response within 30 seconds/,
      );
      await vi.advanceTimersByTimeAsync(30000);
      await failure;
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts a song without a book in Recital Book 3", () => {
    expect(books.map((book) => book.id)).toEqual([...BOOK_IDS, "movies"]);
    expect(bookForSong({ ...ode(), library: undefined }).id).toBe("recital-3");
    expect(bookForSong(undefined).id).toBe("recital-3");
  });
});
