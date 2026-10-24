import type { Song } from "./song";
import { lastIndexAtOrBefore } from "./timeline";

/** A library request that takes longer than this fails, so startup can offer a retry. */
const TIMEOUT_MS = 30000;

/**
 * The Supabase bucket that holds the shared song library. Only signed-in
 * users may read it (see supabase/migrations).
 */
export const LIBRARY_BUCKET = "library";
export const COLLECTION_IDS = ["classes", "songs", "pops", "movies"] as const;
export type LibraryCollection = (typeof COLLECTION_IDS)[number];
/** The books of George Bear’s Classes. */
export const BOOK_IDS = ["recital-3", "lesson-3"] as const;
export type LibraryBook = (typeof BOOK_IDS)[number];
/**
 * A book of the app's library: one of George Bear’s Classes, or Movie Themes,
 * the `movies` collection as one book.
 */
export type SongBook = LibraryBook | "movies";
/** The book of a classes song that names none. */
const DEFAULT_BOOK: LibraryBook = "recital-3";

/** One song in index.json. Paths are relative to the bucket. */
export interface LibraryEntry {
  id: string;
  title: string;
  /** The app shows `classes` and `movies`; the bucket keeps the others. */
  collection: LibraryCollection;
  /** The class book of a `classes` song: recital-3 when left out. */
  book?: LibraryBook;
  /**
   * The song in the app's format, as JSON: songs/<id>.json. Published paths
   * end in the file's content hash (songs/<id>.<hash>.json), so a changed
   * song gets a new name.
   */
  song: string;
  /** Its MIDI file, for downloads, named the same way: songs/<id>.mid. */
  midi?: string;
}
export interface LibraryIndex {
  version: 1;
  songs: LibraryEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const whole = (value: unknown) => Number.isSafeInteger(value);
const text = (value: unknown) => typeof value === "string" && value !== "";
/** Text matched literally inside a regular expression. */
const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fail(where: string, problem: string): never {
  throw new Error(`${where}: ${problem}`);
}

interface Span {
  channel: number;
  start: number;
  end: number;
  open?: true;
}
/** A sustain-pedal press inside a song `duration` seconds long. */
const pedalSpan = (value: unknown, duration: number): value is Span =>
  isRecord(value) &&
  whole(value.channel) &&
  finite(value.start) &&
  finite(value.end) &&
  // Left down at the end of the file, or absent.
  (value.open === undefined || value.open === true) &&
  (value.start as number) >= 0 &&
  (value.end as number) >= (value.start as number) &&
  (value.end as number) <= duration + 1e-6;

/**
 * A note of either part that sounds inside a song `duration` seconds long,
 * in order: playback, scoring and the score all assume it. A silent note
 * would still be a target to play.
 */
const soundingNote = (
  value: unknown,
  duration: number,
): value is Record<string, unknown> & {
  id: string;
  pitch: number;
  start: number;
  end: number;
  soundEnd: number;
  channel: number;
} =>
  isRecord(value) &&
  text(value.id) &&
  whole(value.pitch) &&
  (value.pitch as number) >= 0 &&
  (value.pitch as number) <= 127 &&
  finite(value.start) &&
  finite(value.end) &&
  finite(value.soundEnd) &&
  finite(value.velocity) &&
  (value.velocity as number) > 0 &&
  (value.velocity as number) <= 1 &&
  whole(value.channel) &&
  (value.start as number) >= 0 &&
  (value.end as number) >= (value.start as number) &&
  (value.soundEnd as number) >= (value.end as number) &&
  (value.soundEnd as number) <= duration + 1e-6;

/** Check index.json and return it typed. Throws with the first problem found. */
export function validateIndex(value: unknown): LibraryIndex {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.songs))
    fail("index.json", "expected { version: 1, songs: [...] }");
  const ids = new Set<string>();
  value.songs.forEach((entry: unknown, i) => {
    const where = `index.json songs[${i}]`;
    if (!isRecord(entry)) fail(where, "not an object");
    if (!text(entry.id) || !/^[A-Za-z0-9._-]{1,128}$/.test(entry.id as string))
      fail(where, "id must use letters, digits, dot, dash or underscore");
    if (ids.has(entry.id as string)) fail(where, `duplicate id ${entry.id}`);
    ids.add(entry.id as string);
    if (!text(entry.title)) fail(where, "missing title");
    if (!COLLECTION_IDS.includes(entry.collection as LibraryCollection))
      fail(where, `collection must be one of ${COLLECTION_IDS.join(", ")}`);
    if (
      entry.book !== undefined &&
      !BOOK_IDS.includes(entry.book as LibraryBook)
    )
      fail(where, `book must be one of ${BOOK_IDS.join(", ")}`);
    // Paths name the song's own files in songs/, optionally with a content
    // hash, so nothing can point outside the library folder.
    const path = (ext: string) =>
      new RegExp(
        `^songs/${literal(entry.id as string)}(\\.[0-9a-f]{16})?\\.${ext}$`,
      );
    if (typeof entry.song !== "string" || !path("json").test(entry.song))
      fail(where, "song must be songs/<id>.json, with an optional hash");
    if (
      entry.midi !== undefined &&
      (typeof entry.midi !== "string" || !path("mid").test(entry.midi))
    )
      fail(where, "midi must be songs/<id>.mid, with an optional hash");
  });
  if (!value.songs.length) fail("index.json", "the library has no songs");
  return value as unknown as LibraryIndex;
}

/** Check one song file against the app's Song format. */
export function validateSong(value: unknown, id: string): Song {
  const where = `song ${id}`;
  if (!isRecord(value)) fail(where, "not an object");
  if (value.id !== id) fail(where, `its id is ${String(value.id)}`);
  if (!text(value.title)) fail(where, "missing title");
  if (!finite(value.duration) || (value.duration as number) <= 0)
    fail(where, "duration must be a positive number");
  const duration = value.duration as number;
  if (!whole(value.ppq) || (value.ppq as number) <= 0)
    fail(where, "ppq must be a positive whole number");
  // The studio renders these fields directly, so each must have its type.
  if (
    !Array.isArray(value.warnings) ||
    !value.warnings.every((w) => typeof w === "string")
  )
    fail(where, "warnings must be a list of text");
  if (
    !Array.isArray(value.tempos) ||
    !value.tempos.every(
      (t) =>
        isRecord(t) &&
        whole(t.tick) &&
        (t.tick as number) >= 0 &&
        finite(t.microseconds) &&
        (t.microseconds as number) > 0,
    )
  )
    fail(where, "tempos must be a list of { tick, microseconds > 0 }");
  if (
    value.timeSignatures !== undefined &&
    !(
      Array.isArray(value.timeSignatures) &&
      value.timeSignatures.every(
        // The score ignores any other meter (see createMeterMap).
        (t) =>
          isRecord(t) &&
          whole(t.tick) &&
          (t.tick as number) >= 0 &&
          (t.tick as number) <= 2 ** 40 &&
          whole(t.numerator) &&
          (t.numerator as number) >= 1 &&
          (t.numerator as number) <= 255 &&
          whole(t.denominator) &&
          (t.denominator as number) >= 1 &&
          (t.denominator as number) <= 1024 &&
          ((t.denominator as number) & ((t.denominator as number) - 1)) === 0,
      )
    )
  )
    fail(
      where,
      "timeSignatures must be a list of { tick, numerator 1-255, denominator a power of two }",
    );
  // The score would quietly replace anything else (see createMeterMap).
  if (
    value.beatsPerBar !== undefined &&
    !(finite(value.beatsPerBar) && (value.beatsPerBar as number) > 0)
  )
    fail(where, "beatsPerBar must be a positive number");
  if (
    value.leadInBeats !== undefined &&
    !(finite(value.leadInBeats) && (value.leadInBeats as number) >= 0)
  )
    fail(where, "leadInBeats must be zero or more");
  if (
    value.lesson !== undefined &&
    !(
      isRecord(value.lesson) &&
      ["composer", "description", "level"].every(
        (key) =>
          typeof (value.lesson as Record<string, unknown>)[key] === "string",
      ) &&
      finite(value.lesson.bpm) &&
      isRecord(value.lesson.handPositions) &&
      typeof value.lesson.handPositions.left === "string" &&
      typeof value.lesson.handPositions.right === "string"
    )
  )
    fail(
      where,
      "lesson needs composer, description, level, bpm and handPositions",
    );
  if (
    value.source !== undefined &&
    !(
      isRecord(value.source) &&
      ["composer", "description", "url", "credit"].every(
        (key) =>
          typeof (value.source as Record<string, unknown>)[key] === "string",
      )
    )
  )
    fail(where, "source needs composer, description, url and credit");
  // Only a missing list means no pedal; null is not a list.
  const pedals = value.pedals === undefined ? [] : value.pedals;
  if (!Array.isArray(pedals) || !pedals.every((p) => pedalSpan(p, duration)))
    fail(
      where,
      "pedals must be a list of { channel, start, end } inside the song",
    );
  // Pedal lookup searches each channel's spans by start time.
  // One channel's pedal is down for one span at a time.
  // A span still down at the end of the file is the channel's last.
  const spans = new Map<number, Span[]>();
  for (const p of pedals as Span[]) {
    const list = spans.get(p.channel) ?? [];
    const last = list.at(-1);
    if (last && (last.open || p.start < last.end))
      fail(
        where,
        "pedals must be in start order on each channel, without overlaps",
      );
    list.push(p);
    spans.set(p.channel, list);
  }
  if (!Array.isArray(value.tracks) || !value.tracks.length)
    fail(where, "missing tracks");
  // Progress records each track's hand, and must fit its database row.
  if (value.tracks.length > 256) fail(where, "more than 256 tracks");
  const tracks = new Set<number>();
  for (const track of value.tracks as unknown[]) {
    if (
      !isRecord(track) ||
      !whole(track.id) ||
      typeof track.name !== "string" ||
      !["left", "right", "off"].includes(track.hand as string) ||
      !whole(track.count) ||
      (track.count as number) < 0
    )
      fail(where, "each track needs id, name, hand and count");
    if (tracks.has(track.id as number))
      fail(where, `duplicate track id ${track.id}`);
    tracks.add(track.id as number);
  }
  if (!Array.isArray(value.notes) || !value.notes.length)
    fail(where, "missing notes");
  // Scoring, rendering and playback key on note ids, across both parts, so
  // each must be unique.
  const ids = new Set<string>();
  const unique = (id: string) => {
    if (ids.has(id)) fail(where, `duplicate note id ${id}`);
    ids.add(id);
  };
  for (const note of value.notes as unknown[]) {
    if (
      !soundingNote(note, duration) ||
      note.start >= duration ||
      !tracks.has(note.track as number) ||
      (note.finger !== undefined &&
        ![1, 2, 3, 4, 5].includes(note.finger as number)) ||
      (note.fingerHand !== undefined &&
        !["left", "right"].includes(note.fingerHand as string)) ||
      (note.notatedBeats !== undefined &&
        (!finite(note.notatedBeats) || (note.notatedBeats as number) <= 0)) ||
      (note.staccato !== undefined && typeof note.staccato !== "boolean")
    )
      fail(where, `bad note ${isRecord(note) ? String(note.id) : ""}`);
    unique(note.id);
    // A key released while its channel's pedal is down sounds until the
    // pedal lifts, as parseSong records it: playback stops each note at
    // soundEnd. Each channel's spans are in start order (checked above), so
    // the span holding a release is the last that starts at or before it.
    const list = spans.get(note.channel) ?? [];
    const span = list[lastIndexAtOrBefore(list, "start", note.end)];
    if (span && note.end < span.end && note.soundEnd < span.end - 1e-6)
      fail(where, `note ${note.id} stops before the pedal holding it lifts`);
  }
  // The assignment panel lists tracks by count, so each must be exact.
  for (const track of value.tracks as { id: number; count: number }[]) {
    const owned = (value.notes as { track: number }[]).filter(
      (note) => note.track === track.id,
    ).length;
    if (track.count !== owned)
      fail(where, `track ${track.id} count is ${track.count}, not ${owned}`);
  }
  if (value.duet !== undefined) {
    // The teacher part plays along with Duet on, and the student part moves
    // by its octaves (see Studio.octaveShift), so both must stay on the keys.
    const duet = value.duet;
    if (
      !isRecord(duet) ||
      ![-1, 0, 1, 2].includes(duet.octaves as number) ||
      !Array.isArray(duet.notes) ||
      !duet.notes.length
    )
      fail(where, "duet needs octaves (-1 to 2) and notes");
    const shift = 12 * (duet.octaves as number);
    for (const note of value.notes as { id: string; pitch: number }[])
      if (note.pitch + shift < 0 || note.pitch + shift > 127)
        fail(where, `note ${note.id} leaves the keyboard with the duet`);
    for (const note of duet.notes as unknown[]) {
      if (
        !soundingNote(note, duration) ||
        !whole(note.track) ||
        // Never scored, waited for or fingered: not one of the student's.
        tracks.has(note.track as number) ||
        note.finger !== undefined ||
        note.fingerHand !== undefined
      )
        fail(where, `bad duet note ${isRecord(note) ? String(note.id) : ""}`);
      unique(note.id);
    }
  }
  return value as unknown as Song;
}

/**
 * Load the songs of George Bear’s Classes, the `classes` collection, and of
 * Movie Themes, the `movies` collection. `url`
 * turns a bucket path into its URL, and `fetcher` reads it, as the signed-in
 * user in the app. The index is revalidated on every load. Song files are
 * named after their content hash and served with a one-year cache, so the
 * browser keeps them until a song changes and gets a new name.
 */
export async function loadLibrary(
  url: (path: string) => string,
  fetcher: typeof fetch = fetch,
): Promise<Song[]> {
  const get = async (path: string, revalidate = false) => {
    // A stalled request must not hold the studio's loading screen forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher(
        url(path),
        revalidate
          ? { cache: "no-cache", signal: controller.signal }
          : { signal: controller.signal },
      );
      if (!response.ok)
        throw new Error(`Library file ${path}: HTTP ${response.status}`);
      return (await response.json()) as unknown;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(`Library file ${path}: no response within 30 seconds`, {
          cause: error,
        });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const index = validateIndex(await get("index.json", true));
  // Earlier builds still show the other collections, so they stay in the bucket.
  const shown = index.songs.filter(
    (entry) => entry.collection === "classes" || entry.collection === "movies",
  );
  if (!shown.some((entry) => entry.collection === "classes"))
    fail("index.json", "George Bear’s Classes has no songs");
  return Promise.all(
    shown.map(async (entry) => {
      const song = validateSong(await get(entry.song), entry.id);
      return {
        ...song,
        title: entry.title,
        library: {
          book:
            entry.collection === "movies"
              ? "movies"
              : (entry.book ?? DEFAULT_BOOK),
          midi: entry.midi ? url(entry.midi) : undefined,
        },
      };
    }),
  );
}
