import { readFileSync } from "node:fs";
import {
  test as base,
  type BrowserContext,
  type Route,
} from "@playwright/test";

/**
 * The Supabase project the e2e build talks to. Nothing answers at this
 * address: every request to it is answered by FakeSupabase below, inside the
 * browser context, so the suite needs no network, account or Google sign-in.
 */
export const SUPABASE_URL = "https://e2e.supabase.test";
/** Where supabase-js keeps the session: sb-<first host label>-auth-token. */
const SESSION_KEY = "sb-e2e-auth-token";

export const USER = {
  id: "00000000-0000-4000-8000-00000000e2e0",
  email: "george@example.com",
  firstName: "George",
};

interface LibrarySong {
  id: string;
  title: string;
  [key: string]: unknown;
}
/** The three library songs the unit tests use (see tests/fixtures). */
const fixtureSongs = (
  JSON.parse(
    readFileSync(
      new URL("../tests/fixtures/library-songs.json", import.meta.url),
      "utf8",
    ),
  ) as { song: LibrarySong }[]
).map(({ song }) => song);
const fixture = (id: string) => fixtureSongs.find((song) => song.id === id)!;

/**
 * The library bucket: one song in each book of George Bear’s Classes, one in
 * Movie Themes (Ode to Joy's notes under another name), and one from another
 * collection that the app must leave out.
 */
export const LIBRARY = [
  { song: fixture("cadence-dancing-raindrops-v1"), book: "recital-3" },
  { song: fixture("pawpal-five-oclock-v1"), book: "lesson-3" },
  {
    song: {
      ...fixture("cadence-ode-to-joy-v1"),
      id: "e2e-film-theme-v1",
      title: "A Film Theme",
    },
    collection: "movies",
  },
  { song: fixture("cadence-ode-to-joy-v1"), collection: "songs" },
].map(({ song, book, collection = "classes" }) => ({
  song,
  entry: {
    id: song.id,
    title: song.title,
    collection,
    ...(book && { book }),
    song: `songs/${song.id}.json`,
    midi: `songs/${song.id}.mid`,
  },
}));

/**
 * The course CD's manifest in the cd-audio bucket, cut down: Five O'Clock,
 * the library's one piece of Lesson Book 3, is the CD's first piece, so its
 * story is the opening story and the one leading into it (tracks 1 and 2).
 * Track 4 is the closing story, which leads into no piece.
 */
export const CD_MANIFEST = {
  version: 1,
  title: "Music for Little Mozarts: Lesson and Discovery, Level 3",
  publisher: "Alfred Music",
  year: 2015,
  tracks: [
    { disc: 1, track: 1, title: "Opening Story", kind: "story" },
    { disc: 1, track: 2, title: "The Story Goes On", kind: "story" },
    {
      disc: 1,
      track: 3,
      title: "Five O'Clock",
      kind: "song",
      songId: "pawpal-five-oclock-v1",
    },
    { disc: 1, track: 4, title: "Closing Story", kind: "story" },
    { disc: 2, track: 1, title: "Discovery", kind: "discovery" },
  ].map((track) => ({
    ...track,
    audio: `mflm-3/disc-${track.disc}/${String(track.track).padStart(2, "0")}.mp3`,
  })),
};

/**
 * Silent audio `seconds` long, standing in for a track of the CD, which never
 * goes into this repository: a WAV file (8 kHz, 16-bit mono), which the
 * browser plays whatever the file is called.
 */
function silence(seconds: number) {
  const data = Math.round(seconds * 8000) * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write("RIFF", 0, "latin1");
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVEfmt ", 8, "latin1");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "latin1");
  wav.writeUInt32LE(data, 40);
  return wav;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
  "access-control-expose-headers": "content-range",
};

/** An access token shaped like Supabase's. Nothing checks its signature. */
function accessToken(exp: number) {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    part({ alg: "HS256", typ: "JWT" }),
    part({
      sub: USER.id,
      email: USER.email,
      aud: "authenticated",
      role: "authenticated",
      exp,
      iat: exp - 3600,
      session_id: "e2e-session",
    }),
    "e2e-signature",
  ].join(".");
}

/** A signed-in Google session for USER, valid for an hour. */
export function session() {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: accessToken(expiresAt),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: "e2e-refresh-token",
    user: {
      id: USER.id,
      aud: "authenticated",
      role: "authenticated",
      email: USER.email,
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {
        given_name: USER.firstName,
        full_name: `${USER.firstName} Bear`,
      },
      identities: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  };
}

/** Whether an Authorization header carries a signed-in user's access token. */
function signedInRequest(authorization: string | undefined) {
  const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    ) as { role?: string; sub?: string; exp?: number };
    return (
      claims.role === "authenticated" &&
      claims.sub === USER.id &&
      (claims.exp ?? 0) * 1000 > Date.now()
    );
  } catch {
    return false;
  }
}

/**
 * The browser storage of a context already signed in, as supabase-js leaves
 * it after Google sign-in.
 */
export const signedIn = (origin: string) => ({
  cookies: [],
  origins: [
    {
      origin,
      localStorage: [{ name: SESSION_KEY, value: JSON.stringify(session()) }],
    },
  ],
});

type Row = { user_id: string; song_id: string; data: unknown };
/** A practice_sessions row, as the app uploads it. */
export interface PracticeRow {
  id: string;
  user_id?: string;
  day: string;
  started_at: string;
  seconds: number;
  songs: Record<string, number>;
}

/**
 * Supabase as the app uses it: Google sign-in (PKCE), the settings and
 * progress tables, and the song library and course CD buckets, which only
 * signed-in users may read. Tests read and change its state to arrange and
 * check what the app sent.
 */
export class FakeSupabase {
  /** The account's settings row, or null for a new account. */
  settings: Record<string, unknown> | null = null;
  /** The account's progress rows by song id. */
  progress = new Map<string, unknown>();
  /** The account's practice sessions by id. */
  practice = new Map<string, PracticeRow>();
  /** Every settings upload, oldest first. */
  settingsUploads: Record<string, unknown>[] = [];
  /** Every Google sign-in the app started. */
  authorizations: URL[] = [];
  /** How many times the app signed out with Supabase. */
  signOuts = 0;
  /** Answer library requests with a server error. */
  libraryDown = false;
  /** cd-audio files the app asked for, in order. */
  cdAudioRequests: string[] = [];
  /** cd-audio files to answer with a server error. */
  cdAudioDown = new Set<string>();
  /** How long each CD track lasts, in seconds, by path: 30 unless set. */
  cdTrackSeconds: Record<string, number> = {};
  /** Requests nothing here answers, which a test should fail on. */
  unexpected: string[] = [];

  async attach(context: BrowserContext) {
    await context.route(`${SUPABASE_URL}/**`, (route) => this.handle(route));
  }

  private async handle(route: Route) {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;
    if (method === "OPTIONS")
      return route.fulfill({ status: 204, headers: CORS });

    const library = "/storage/v1/object/authenticated/library/";
    if (path.startsWith(library))
      return this.library(route, path.slice(library.length));
    const cdAudio = "/storage/v1/object/authenticated/cd-audio/";
    if (path.startsWith(cdAudio))
      return this.cdAudio(route, path.slice(cdAudio.length));

    if (path === "/auth/v1/authorize") {
      // Google says yes at once and returns to the app with a PKCE code.
      this.authorizations.push(url);
      const back = new URL(url.searchParams.get("redirect_to")!);
      back.searchParams.set("code", "e2e-auth-code");
      return route.fulfill({ status: 302, headers: { location: back.href } });
    }
    if (path === "/auth/v1/token") return json(route, session());
    if (path === "/auth/v1/user") return json(route, session().user);
    if (path === "/auth/v1/logout") {
      this.signOuts++;
      return route.fulfill({ status: 204, headers: CORS });
    }

    if (path === "/rest/v1/settings") {
      if (method === "GET")
        return json(route, this.settings ? [{ data: this.settings }] : []);
      if (method === "POST") {
        const { data } = request.postDataJSON() as {
          data: Record<string, unknown>;
        };
        this.settings = data;
        this.settingsUploads.push(data);
        return route.fulfill({ status: 201, headers: CORS, body: "" });
      }
    }
    if (path === "/rest/v1/progress") {
      if (method === "POST") {
        const rows = [request.postDataJSON() as Row | Row[]].flat();
        for (const row of rows) this.progress.set(row.song_id, row.data);
        return route.fulfill({ status: 201, headers: CORS, body: "" });
      }
      const rows = this.progressRows(url.searchParams.get("song_id"));
      if (method === "HEAD")
        return route.fulfill({
          status: 200,
          headers: { ...CORS, "content-range": `*/${rows.length}` },
        });
      if (method === "GET") return json(route, rows);
    }

    if (path === "/rest/v1/practice_sessions") {
      if (method === "POST") {
        // An upload never lowers a session's time (practice_sessions_never_shrink).
        for (const row of [request.postDataJSON() as PracticeRow].flat()) {
          const had = this.practice.get(row.id);
          if (!had || had.seconds <= row.seconds)
            this.practice.set(row.id, row);
        }
        return route.fulfill({ status: 201, headers: CORS, body: "" });
      }
      if (method === "GET") {
        const since = url.searchParams.get("day")?.replace(/^gte\./, "") ?? "";
        const after = url.searchParams.get("id")?.replace(/^gt\./, "") ?? "";
        return json(
          route,
          [...this.practice.values()]
            .filter((row) => row.day >= since && row.id > after)
            .sort((a, b) => a.id.localeCompare(b.id)),
        );
      }
    }

    this.unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 404, headers: CORS, body: "{}" });
  }

  /** Progress rows in song id order, with the app's one song_id filter. */
  private progressRows(filter: string | null) {
    let rows = [...this.progress]
      .map(([song_id, data]) => ({ song_id, data }))
      .sort((a, b) => a.song_id.localeCompare(b.song_id));
    if (filter?.startsWith("gt."))
      rows = rows.filter((row) => row.song_id > filter.slice(3));
    else if (filter?.startsWith("in.(")) {
      const ids = filter
        .slice(4, -1)
        .split(",")
        .map((id) => id.replace(/^"|"$/g, ""));
      rows = rows.filter((row) => ids.includes(row.song_id));
    }
    return rows;
  }

  private library(route: Route, file: string) {
    if (!signedInRequest(route.request().headers().authorization))
      return notFound(route);
    if (this.libraryDown)
      return route.fulfill({ status: 503, headers: CORS, body: "down" });
    if (file === "index.json")
      return json(route, {
        version: 1,
        songs: LIBRARY.map(({ entry }) => entry),
      });
    const found = LIBRARY.find(
      ({ entry }) => entry.song === file || entry.midi === file,
    );
    if (!found) return route.fulfill({ status: 404, headers: CORS });
    if (file.endsWith(".json")) return json(route, found.song);
    return route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "audio/midi" },
      body: Buffer.from("MThd"),
    });
  }

  /** The cd-audio bucket: the manifest, and silence for each track. */
  private cdAudio(route: Route, file: string) {
    if (!signedInRequest(route.request().headers().authorization))
      return notFound(route);
    this.cdAudioRequests.push(file);
    if (this.cdAudioDown.has(file))
      return route.fulfill({ status: 503, headers: CORS, body: "down" });
    if (file === "mflm-3/manifest.json") return json(route, CD_MANIFEST);
    if (!CD_MANIFEST.tracks.some((track) => track.audio === file))
      return notFound(route);
    return route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "audio/wav" },
      body: silence(this.cdTrackSeconds[file] ?? 30),
    });
  }
}

/**
 * Storage's answer for a file that is not there, and for a private bucket's
 * file asked for without a signed-in user's access token, such as with just
 * the publishable key.
 */
function notFound(route: Route) {
  return route.fulfill({
    status: 400,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify({
      statusCode: "404",
      error: "not_found",
      message: "Object not found",
    }),
  });
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    headers: { ...CORS, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Tests run signed in to a new account by default; `test.use({ storageState:
 * { cookies: [], origins: [] } })` starts signed out instead. Each test fails
 * if the app made a Supabase request the fake does not know. (Playwright's
 * fixture callback is named `provide` here, since the React hook lint rule
 * takes any call to `use` for React's hook.)
 */
export const test = base.extend<{ supabase: FakeSupabase }>({
  storageState: async ({ baseURL }, provide) => provide(signedIn(baseURL!)),
  supabase: [
    async ({ context }, provide) => {
      const supabase = new FakeSupabase();
      await supabase.attach(context);
      await provide(supabase);
      if (supabase.unexpected.length)
        throw new Error(
          `Unexpected Supabase requests: ${supabase.unexpected.join(", ")}`,
        );
    },
    { auto: true },
  ],
});
export { expect } from "@playwright/test";
