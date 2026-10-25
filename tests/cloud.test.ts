import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BrowserStorageError,
  CloudSync,
  UnsentChangesError,
} from "../src/cloud";
import { clearAccountData, read, write } from "../src/storage";
import { addDays, localDay } from "../src/practiceLog";

vi.mock("../src/storage", async (importActual) => {
  const actual = await importActual<typeof import("../src/storage")>();
  return { ...actual, clearAccountData: vi.fn(actual.clearAccountData) };
});

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

interface PracticeRow {
  id: string;
  day: string;
  started_at: string;
  seconds: number;
  songs: Record<string, number>;
}

interface Backend {
  settings: { data: unknown }[];
  progress: { song_id: string; data: unknown }[];
  practice_sessions: PracticeRow[];
  /** Sessions practice_sessions' checks refuse: an upload holding one fails whole. */
  refusePractice: string[];
  upserts: [string, unknown][];
  calls: string[];
  failWrites: boolean;
  /** Writes to reject, by label, such as "upsert settings". */
  failLabels: string[];
  /** The account's song limit: an upload with more new songs is refused whole. */
  limit: number;
  /** "abort": writes answer only when aborted. "manual": when release() runs. */
  hang: "no" | "abort" | "manual";
  release: () => void;
  signOutError: unknown;
  /** How long Supabase takes to answer a sign-out, in ms. */
  signOutDelay: number;
  /** Makes the settings read fail, as a broken connection would. */
  failReads: boolean;
  /** When set, reads wait for this promise. */
  readGate: Promise<void> | null;
}

function backend(): Backend {
  return {
    settings: [],
    progress: [],
    practice_sessions: [],
    refusePractice: [],
    upserts: [],
    calls: [],
    failWrites: false,
    failLabels: [],
    limit: Infinity,
    hang: "no",
    release: () => {},
    signOutError: null,
    signOutDelay: 0,
    failReads: false,
    readGate: null,
  };
}

/** Just the parts of the Supabase client that CloudSync uses. */
function client(b: Backend) {
  const reply = (data: unknown, error: unknown = null) => ({ data, error });
  // A write is sent when the client attaches its abort signal.
  const write = (label: string, upsert: [string, unknown]) => ({
    abortSignal: (signal: AbortSignal) => {
      b.calls.push(label);
      if (b.hang === "abort")
        return new Promise((resolve) =>
          signal.addEventListener("abort", () =>
            resolve(reply(null, { message: "aborted" })),
          ),
        );
      if (b.hang === "manual")
        return new Promise((resolve) => {
          b.release = () => {
            b.upserts.push(upsert);
            resolve(reply(null));
          };
        });
      if (
        upsert[0] === "practice_sessions" &&
        (upsert[1] as { id: string }[]).some((row) =>
          b.refusePractice.includes(row.id),
        )
      )
        return Promise.resolve(
          reply(null, { code: "23514", message: "check violation" }),
        );
      const rows = (
        upsert[0] === "progress" && Array.isArray(upsert[1]) ? upsert[1] : []
      ) as {
        song_id: string;
        data: unknown;
      }[];
      const added = rows.filter(
        (row) => !b.progress.some((have) => have.song_id === row.song_id),
      );
      if (b.progress.length + added.length > b.limit)
        return Promise.resolve(
          reply(null, { code: "23514", message: "limit reached" }),
        );
      if (upsert[0] === "progress" && b.limit !== Infinity)
        b.progress.push(
          ...added.map(({ song_id, data }) => ({ song_id, data })),
        );
      const fails = b.failWrites || b.failLabels.includes(label);
      if (!fails) b.upserts.push(upsert);
      return Promise.resolve(
        reply(null, fails ? { message: "offline" } : null),
      );
    },
  });
  /** A keyset-paged read in `column` order, of the rows `keep` takes. */
  const ordered = (
    table: "settings" | "progress" | "practice_sessions",
    column: "song_id" | "id",
    keep: (row: Record<string, unknown>) => boolean = () => true,
  ) => {
    let after: string | undefined;
    let count = Infinity;
    const query = {
      gt: (_column: string, value: string) => ((after = value), query),
      limit: (n: number) => ((count = n), query),
      then: (
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) =>
        (async () => {
          b.calls.push(`read ${table}`);
          await b.readGate;
          const rows = [...(b[table] as Record<string, string>[])]
            .filter(keep)
            .sort((x, y) => (x[column] < y[column] ? -1 : 1))
            .filter((row) => after === undefined || row[column] > after);
          return reply(rows.slice(0, count));
        })().then(resolve, reject),
    };
    return query;
  };
  const fake = {
    from: (table: "settings" | "progress" | "practice_sessions") => ({
      select: (_columns?: string, options?: { count?: string }) =>
        options?.count
          ? Promise.resolve({ data: null, error: null, count: b[table].length })
          : {
              maybeSingle: async () => {
                b.calls.push(`read ${table}`);
                await b.readGate;
                return b.failReads
                  ? reply(null, { message: "offline" })
                  : reply(b[table][0] ?? null);
              },
              in: async (_column: "song_id", ids: string[]) => {
                b.calls.push(`read ${table}`);
                await b.readGate;
                return reply(
                  (b[table] as { song_id: string }[]).filter((row) =>
                    ids.includes(row.song_id),
                  ),
                );
              },
              gte: (field: "day", since: string) => ({
                order: (column: "id") =>
                  ordered(table, column, (row) => String(row[field]) >= since),
              }),
              order: (column: "song_id") => ordered(table, column),
            },
      upsert: (rows: unknown) => write(`upsert ${table}`, [table, rows]),
    }),
    auth: {
      signOut: vi.fn(async () => {
        if (b.signOutDelay)
          await new Promise((resolve) => setTimeout(resolve, b.signOutDelay));
        return { error: b.signOutError };
      }),
    },
  };
  return fake as unknown as SupabaseClient & typeof fake;
}

const stored = new Map<string, string>();
let storageBlocked = false;
/** A key browser storage refuses, as when it is nearly full. */
let refusedKey = "";
beforeEach(() => {
  stored.clear();
  storageBlocked = false;
  refusedKey = "";
  vi.stubGlobal("localStorage", {
    get length() {
      return stored.size;
    },
    key: (i: number) => [...stored.keys()][i] ?? null,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storageBlocked) throw new DOMException("Blocked", "SecurityError");
      if (key === refusedKey)
        throw new DOMException("Full", "QuotaExceededError");
      stored.set(key, value);
    },
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.useFakeTimers();
  vi.mocked(clearAccountData).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The upload queue in browser storage. */
const queue = () =>
  read<{
    owner?: string;
    settings?: unknown;
    progress?: Record<string, unknown>;
  } | null>("pending", null);
const queued = () => Object.keys(queue()?.progress ?? {});

const today = () => localDay(new Date());
/** A practice session `seconds` long on `day` (today unless given). */
function practiceSession(id: string, seconds: number, day = today()) {
  return {
    id,
    day,
    startedAt: `${day}T18:00:00.000Z`,
    seconds,
    songs: { song: seconds },
  };
}
/** The practice_sessions row for practiceSession(). */
function practiceRow(id: string, seconds: number, day = today()) {
  return {
    id,
    day,
    started_at: `${day}T18:00:00.000Z`,
    seconds,
    songs: { song: seconds },
  };
}

describe("loading the account", () => {
  it("takes the account's settings and progress, and drops songs it lacks", async () => {
    const b = backend();
    write("owner", USER);
    write("settings", { mode: "listen" });
    write("progress:song", { best: 1 });
    write("progress:gone", { best: 2 });
    b.settings = [{ data: { mode: "wait" } }];
    b.progress = [{ song_id: "song", data: { best: 7 } }];
    await new CloudSync(client(b), USER).pull();
    expect(read("settings", null)).toEqual({ mode: "wait" });
    expect(read("progress:song", null)).toEqual({ best: 7 });
    expect(read("progress:gone", null)).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(b.upserts).toEqual([]);
  });

  it("adopts this browser's earlier data where a new account has none", async () => {
    const b = backend();
    write("settings", { mode: "listen" });
    write("progress:only-here", { best: 4 });
    write("progress:also-there", { best: 1 });
    b.progress = [{ song_id: "also-there", data: { best: 8 } }];
    await new CloudSync(client(b), USER).pull();
    await vi.advanceTimersByTimeAsync(0);
    expect(read("owner", "")).toBe(USER);
    expect(read("progress:also-there", {})).toEqual({ best: 8 });
    expect(b.upserts).toEqual([
      ["settings", { user_id: USER, data: { mode: "listen" } }],
      [
        "progress",
        [{ user_id: USER, song_id: "only-here", data: { best: 4 } }],
      ],
    ]);
  });

  it("adopts again after a first pull that could not save its queue", async () => {
    const b = backend();
    write("progress:only-here", { best: 4 });
    refusedKey = "cadence:pending";
    await expect(new CloudSync(client(b), USER).pull()).rejects.toBeInstanceOf(
      BrowserStorageError,
    );
    // Not yet the owner, so the retry still adopts this browser's progress.
    expect(read("owner", null)).toBeNull();
    refusedKey = "";
    await new CloudSync(client(b), USER).pull();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.upserts).toEqual([
      [
        "progress",
        [{ user_id: USER, song_id: "only-here", data: { best: 4 } }],
      ],
    ]);
  });

  it("clears another account's data, its unsent changes included", async () => {
    const b = backend();
    write("owner", OTHER);
    write("progress:theirs", { best: 1 });
    write("pending", { owner: OTHER, progress: { theirs: { best: 1 } } });
    await new CloudSync(client(b), USER).pull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(clearAccountData).toHaveBeenCalledOnce();
    expect(read("progress:theirs", null)).toBeNull();
    expect(queue()).toBeNull();
    expect(b.upserts).toEqual([]);
    expect(read("owner", "")).toBe(USER);
  });

  it("first uploads what an earlier visit left waiting", async () => {
    const b = backend();
    write("owner", USER);
    write("pending", { owner: USER, progress: { song: { best: 5 } } });
    b.progress = [{ song_id: "song", data: { best: 3 } }];
    const sync = new CloudSync(client(b), USER);
    expect(sync.pending).toBe(true);
    await sync.pull();
    // The server merges the upload, so the account's copy then includes it.
    expect(b.calls.slice(0, 2)).toEqual(["upsert progress", "read settings"]);
    expect(queue()).toBeNull();
  });

  it("does not open while what was left waiting cannot upload", async () => {
    const b = backend();
    write("owner", USER);
    write("pending", { owner: USER, progress: { song: { best: 5 } } });
    b.failWrites = true;
    const sync = new CloudSync(client(b), USER);
    await expect(sync.pull()).rejects.toThrow(/could not be saved/);
    sync.stop();
    expect(queued()).toEqual(["song"]);
  });

  it("reads every page of progress", async () => {
    const b = backend();
    write("owner", USER);
    b.progress = Array.from({ length: 2500 }, (_, i) => ({
      song_id: `song-${String(i).padStart(4, "0")}`,
      data: { best: i % 100 },
    }));
    await new CloudSync(client(b), USER).pull();
    expect(read("progress:song-2499", {})).toEqual({ best: 99 });
    expect(
      [...stored.keys()].filter((key) => key.startsWith("cadence:progress:")),
    ).toHaveLength(2500);
  });

  it("checks a song added behind a long scan before dropping its copy", async () => {
    const b = backend();
    write("owner", USER);
    b.progress = Array.from({ length: 2500 }, (_, i) => ({
      song_id: `song-${String(i).padStart(4, "0")}`,
      data: { best: 1 },
    }));
    write("progress:song-0500a", { best: 3 });
    const api = client(b);
    const from = api.from;
    let reads = 0;
    api.from = ((table: "progress") => {
      // Another device adds the song behind the scan.
      if (table === "progress" && ++reads === 2)
        b.progress.push({ song_id: "song-0500a", data: { best: 6 } });
      return from(table);
    }) as never;
    await new CloudSync(api, USER).pull();
    expect(read("progress:song-0500a", null)).toEqual({ best: 6 });
  });

  it("refuses to open when this browser cannot store the account's data", async () => {
    const b = backend();
    b.settings = [{ data: { mode: "wait" } }];
    storageBlocked = true;
    await expect(new CloudSync(client(b), USER).pull()).rejects.toBeInstanceOf(
      BrowserStorageError,
    );
  });

  it("gives up on a request that does not answer", async () => {
    const api = client(backend());
    const hang = {
      gt: () => hang,
      limit: () => hang,
      then: () => new Promise(() => {}),
    };
    api.from = (() => ({
      select: () => ({
        maybeSingle: () => new Promise(() => {}),
        order: () => hang,
        gte: () => ({ order: () => hang }),
      }),
    })) as never;
    const pull = new CloudSync(api, USER).pull();
    const failure = expect(pull).rejects.toThrow(/did not respond/);
    await vi.advanceTimersByTimeAsync(30000);
    await failure;
  });

  it("changes nothing when a newer sign-in replaces one still loading", async () => {
    const b = backend();
    let open!: () => void;
    b.readGate = new Promise((resolve) => (open = resolve));
    b.settings = [{ data: { mode: "wait" } }];
    const sync = new CloudSync(client(b), USER);
    const pulling = sync.pull();
    sync.stop();
    open();
    await expect(pulling).rejects.toThrow(/replaced/);
    expect(read("settings", null)).toBeNull();
    expect(read("owner", null)).toBeNull();
  });
});

describe("uploading changes", () => {
  it("uploads a burst once, keeps it queued until confirmed, and retries a failure", async () => {
    const b = backend();
    const sync = new CloudSync(client(b), USER);
    const onChange = vi.fn();
    sync.onChange = onChange;
    sync.settings({ mode: "wait" } as never);
    sync.progress("song", { best: 1 } as never);
    sync.progress("song", { best: 2 } as never);
    expect(queued()).toEqual(["song"]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(b.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.calls).toEqual(["upsert settings", "upsert progress"]);
    expect(b.upserts[1][1]).toEqual([
      { user_id: USER, song_id: "song", data: { best: 2 } },
    ]);
    expect(queue()).toBeNull();

    b.failWrites = true;
    sync.progress("song", { best: 3 } as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync.error).toMatch(/Retrying/);
    expect(queued()).toEqual(["song"]);
    expect(onChange).toHaveBeenCalled();
    b.failWrites = false;
    await vi.advanceTimersByTimeAsync(15000);
    expect(sync.error).toBe("");
    expect(sync.pending).toBe(false);
    expect(b.upserts.at(-1)?.[1]).toEqual([
      { user_id: USER, song_id: "song", data: { best: 3 } },
    ]);
  });

  it("retries only the request that failed", async () => {
    const b = backend();
    const sync = new CloudSync(client(b), USER);
    b.failLabels = ["upsert settings"];
    sync.settings({ mode: "wait" } as never);
    sync.progress("song", { best: 1 } as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(queue()).toMatchObject({ settings: { mode: "wait" }, progress: {} });
    b.failLabels = [];
    await vi.advanceTimersByTimeAsync(15000);
    expect(b.calls).toEqual([
      "upsert settings",
      "upsert progress",
      "upsert settings",
    ]);
    expect(queue()).toBeNull();
  });

  it("keeps a save made during an upload queued, even one back to the account's copy", async () => {
    const b = backend();
    write("owner", USER);
    b.progress = [{ song_id: "song", data: { best: 1 } }];
    const sync = new CloudSync(client(b), USER);
    await sync.pull();
    b.hang = "manual";
    sync.progress("song", { best: 2 } as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(b.calls.at(-1)).toBe("upsert progress");
    sync.progress("song", { best: 1 } as never);
    b.hang = "no";
    b.release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(b.upserts.at(-1)?.[1]).toEqual([
      { user_id: USER, song_id: "song", data: { best: 1 } },
    ]);
    expect(queue()).toBeNull();
  });

  it("sends nothing for saves that match the account, or a song as it opens", async () => {
    const b = backend();
    write("owner", USER);
    b.settings = [{ data: { mode: "wait", speed: 1 } }];
    b.progress = [{ song_id: "song", data: { best: 1, updated: "a" } }];
    const sync = new CloudSync(client(b), USER);
    await sync.pull();
    sync.settings({ speed: 1, mode: "wait" } as never);
    sync.progress("song", { updated: "b", best: 1 } as never);
    sync.progress("new", { best: 0 } as never, true);
    sync.progress("new", { best: 0 } as never);
    await vi.advanceTimersByTimeAsync(5000);
    expect(b.calls.filter((call) => call.startsWith("upsert"))).toEqual([]);
    sync.progress("new", { best: 3 } as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(b.calls.at(-1)).toBe("upsert progress");
  });

  it("drops new songs a full account refuses, and still saves the songs it has", async () => {
    const b = backend();
    write("owner", USER);
    // A full account: 200 songs, "known" among them.
    b.progress = [
      { song_id: "known", data: { best: 1 } },
      ...Array.from({ length: 199 }, (_, i) => ({
        song_id: `song-${i}`,
        data: { best: 1 },
      })),
    ];
    const sync = new CloudSync(client(b), USER);
    await sync.pull();
    b.limit = 200;
    sync.progress("known", { best: 2 } as never);
    sync.progress("new", { best: 1 } as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync.error).toMatch(/200 songs/);
    // The retry starts at once (a timer set during a tick runs 1 ms later).
    await vi.advanceTimersByTimeAsync(1);
    expect(b.upserts.at(-1)?.[1]).toEqual([
      { user_id: USER, song_id: "known", data: { best: 2 } },
    ]);
    expect(queue()).toBeNull();
    // The new song is still not saved, so the notice stays.
    expect(sync.error).toMatch(/200 songs/);
  });

  it("keeps the new songs that still fit when one upload holds too many", async () => {
    const b = backend();
    write("owner", USER);
    b.progress = Array.from({ length: 199 }, (_, i) => ({
      song_id: `song-${i}`,
      data: { best: 1 },
    }));
    b.limit = 200;
    const sync = new CloudSync(client(b), USER);
    await sync.pull();
    sync.progress("a", { best: 1 } as never);
    sync.progress("b", { best: 1 } as never);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(1);
    // One slot was left: the first new song takes it, the second is dropped.
    expect(b.upserts.at(-1)?.[1]).toEqual([
      { user_id: USER, song_id: "a", data: { best: 1 } },
    ]);
    expect(queue()).toBeNull();
    expect(sync.error).toMatch(/200 songs/);
  });

  it("keeps a known song's waiting save when a full account refuses it at sign-in", async () => {
    const b = backend();
    write("owner", USER);
    write("pending", {
      owner: USER,
      progress: { known: { best: 9 }, new: { best: 1 } },
    });
    b.progress = [
      { song_id: "known", data: { best: 2 } },
      ...Array.from({ length: 199 }, (_, i) => ({
        song_id: `song-${i}`,
        data: { best: 1 },
      })),
    ];
    b.limit = 200;
    const sync = new CloudSync(client(b), USER);
    await sync.pull();
    // The account says which songs it has, so only the new one is dropped.
    expect(b.upserts[0]).toEqual([
      "progress",
      [{ user_id: USER, song_id: "known", data: { best: 9 } }],
    ]);
    expect(queue()).toBeNull();
  });

  it("adopts only as many songs as the account has room for", async () => {
    const b = backend();
    for (let i = 0; i < 205; i++)
      write(`progress:song-${String(i).padStart(3, "0")}`, { best: 1 });
    const sync = new CloudSync(client(b), USER);
    sync.flush = async () => {};
    await sync.pull();
    expect(queued()).toHaveLength(200);
  });

  it("uploads at once and says so when storage cannot hold the queue", async () => {
    const b = backend();
    const sync = new CloudSync(client(b), USER);
    refusedKey = "cadence:pending";
    sync.progress("song", { best: 1 } as never);
    expect(sync.error).toMatch(/storage is full/);
    await vi.advanceTimersByTimeAsync(0);
    expect(b.calls).toEqual(["upsert progress"]);
    expect(sync.error).toBe("");
  });

  it("aborts a timed-out upload and holds newer changes until it settles", async () => {
    const b = backend();
    const sync = new CloudSync(client(b), USER);
    b.hang = "abort";
    sync.progress("song", { best: 1 } as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(b.calls).toEqual(["upsert progress"]);
    sync.progress("song", { best: 2 } as never);
    await vi.advanceTimersByTimeAsync(10000);
    expect(b.calls).toEqual(["upsert progress"]);
    b.hang = "no";
    // The first request is aborted 30 s after it started, at 32 s.
    await vi.advanceTimersByTimeAsync(19999);
    expect(b.calls).toEqual(["upsert progress"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.calls).toEqual(["upsert progress", "upsert progress"]);
    expect(b.upserts).toEqual([
      ["progress", [{ user_id: USER, song_id: "song", data: { best: 2 } }]],
    ]);
  });

  it("hands its progress off to the account without touching the stored queue", async () => {
    const b = backend();
    const sync = new CloudSync(client(b), USER);
    sync.progress("song", { best: 1 } as never);
    // Another tab takes over and keeps saving into the stored queue.
    sync.detach();
    write("pending", { owner: USER, progress: { other: { best: 5 } } });
    sync.settings({ mode: "rhythm" } as never);
    sync.progress("song", { best: 2 } as never);
    await sync.handOff();
    await vi.advanceTimersByTimeAsync(20000);
    // Only this tab's progress is sent, once; its settings are left alone.
    expect(b.upserts).toEqual([
      ["progress", [{ user_id: USER, song_id: "song", data: { best: 2 } }]],
    ]);
    expect(queued()).toEqual(["other"]);
  });

  it("keeps trying to hand its progress off while the account refuses it", async () => {
    const b = backend();
    const sync = new CloudSync(client(b), USER);
    sync.detach();
    sync.progress("song", { best: 2 } as never);
    b.failWrites = true;
    const handing = sync.handOff();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.calls).toEqual(["upsert progress"]);
    b.failWrites = false;
    await vi.advanceTimersByTimeAsync(15000);
    await handing;
    expect(b.upserts).toEqual([
      ["progress", [{ user_id: USER, song_id: "song", data: { best: 2 } }]],
    ]);
  });

  it("keeps the queue across a reload, for the same account only", () => {
    const sync = new CloudSync(client(backend()), USER);
    sync.progress("song", { best: 1 } as never);
    sync.stop();
    expect(new CloudSync(client(backend()), USER).pending).toBe(true);
    expect(new CloudSync(client(backend()), OTHER).pending).toBe(false);
  });

  it("sends nothing more once stopped", async () => {
    const b = backend();
    const sync = new CloudSync(client(b), USER);
    sync.progress("song", { best: 1 } as never);
    sync.stop();
    sync.progress("song", { best: 2 } as never);
    await vi.advanceTimersByTimeAsync(20000);
    expect(b.calls).toEqual([]);
  });
});

describe("signing out", () => {
  it("uploads what is waiting, signs this browser out, and clears its copy", async () => {
    const b = backend();
    write("owner", USER);
    write("settings", { mode: "wait" });
    b.settings = [{ data: { mode: "wait" } }];
    // A session the account has: nothing more to send for it.
    b.practice_sessions = [practiceRow("session-1", 300)];
    write("practice:session-1", practiceSession("session-1", 300));
    const api = client(b);
    const sync = new CloudSync(api, USER);
    await sync.pull();
    sync.progress("song", { best: 2 } as never);
    await sync.signOut();
    expect(b.upserts).toEqual([
      ["progress", [{ user_id: USER, song_id: "song", data: { best: 2 } }]],
    ]);
    expect(sync.pending).toBe(false);
    // Other devices keep their sessions.
    expect(api.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearAccountData).toHaveBeenCalledOnce();
    expect(queue()).toBeNull();
    expect(read("settings", null)).toBeNull();
    expect(read("owner", null)).toBeNull();
    // The account keeps practice time, so this browser's copy goes too.
    expect(read("practice:session-1", null)).toBeNull();
  });

  it("asks before dropping practice that could not upload", async () => {
    const b = backend();
    const api = client(b);
    const sync = new CloudSync(api, USER);
    b.failWrites = true;
    sync.progress("song", { best: 2 } as never);
    await expect(sync.signOut()).rejects.toBeInstanceOf(UnsentChangesError);
    // Still signed in, and still syncing.
    expect(api.auth.signOut).not.toHaveBeenCalled();
    expect(sync.pending).toBe(true);
    const uploads = b.calls.length;
    await sync.signOut({ force: true });
    // No second wait on an upload that just failed.
    expect(b.calls).toHaveLength(uploads);
    expect(api.auth.signOut).toHaveBeenCalledOnce();
    expect(queue()).toBeNull();
  });

  it("stays signed in when Supabase cannot end the session", async () => {
    const b = backend();
    b.signOutError = { message: "offline" };
    const sync = new CloudSync(client(b), USER);
    await expect(sync.signOut()).rejects.toEqual({ message: "offline" });
    expect(clearAccountData).not.toHaveBeenCalled();
    sync.progress("song", { best: 1 } as never);
    expect(sync.pending).toBe(true);
  });

  it("waits for Supabase's answer however long sign-out takes", async () => {
    const b = backend();
    b.signOutDelay = 45000;
    const sync = new CloudSync(client(b), USER);
    const done = vi.fn();
    const signing = sync.signOut().then(done);
    await vi.advanceTimersByTimeAsync(30000);
    // A time limit here would report failure, then sign out anyway.
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);
    await signing;
    expect(done).toHaveBeenCalledOnce();
    expect(clearAccountData).toHaveBeenCalledOnce();
  });
});

describe("practice time", () => {
  it("loads the account's recent sessions, keeping the larger copy of each", async () => {
    const b = backend();
    write("owner", USER);
    const old = addDays(today(), -92);
    b.practice_sessions = [
      practiceRow("from-phone", 300, addDays(today(), -1)),
      practiceRow("both", 120),
      practiceRow("bigger-there", 200),
      practiceRow("too-old", 500, old),
    ];
    write("practice:both", practiceSession("both", 180));
    write("practice:bigger-there", practiceSession("bigger-there", 60));
    write("practice:only-here", practiceSession("only-here", 90));
    await new CloudSync(client(b), USER).pull();
    expect(read("practice:from-phone", null)).toEqual(
      practiceSession("from-phone", 300, addDays(today(), -1)),
    );
    expect(read("practice:bigger-there", null)).toEqual(
      practiceSession("bigger-there", 200),
    );
    expect(read("practice:both", null)).toEqual(practiceSession("both", 180));
    // Older than the calendar keeps: not loaded.
    expect(read("practice:too-old", null)).toBeNull();
    await vi.advanceTimersByTimeAsync(0);
    // What only this browser had, or had more of, uploads.
    expect(b.upserts).toEqual([
      [
        "practice_sessions",
        expect.arrayContaining([
          { user_id: USER, ...practiceRow("both", 180) },
          { user_id: USER, ...practiceRow("only-here", 90) },
        ]),
      ],
    ]);
    expect((b.upserts[0][1] as unknown[]).length).toBe(2);
    expect(queue()).toBeNull();
  });

  it("uploads a session as it gains time, and retries a failure", async () => {
    const b = backend();
    const sync = new CloudSync(client(b), USER);
    sync.practice(practiceSession("s", 30));
    sync.practice(practiceSession("s", 45));
    expect(sync.pending).toBe(true);
    expect(
      Object.keys(read<{ practice?: object }>("pending", {}).practice ?? {}),
    ).toEqual(["s"]);
    b.failWrites = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync.error).toMatch(/Retrying/);
    expect(sync.pending).toBe(true);
    b.failWrites = false;
    await vi.advanceTimersByTimeAsync(15000);
    expect(b.upserts).toEqual([
      ["practice_sessions", [{ user_id: USER, ...practiceRow("s", 45) }]],
    ]);
    expect(sync.error).toBe("");
    expect(sync.pending).toBe(false);
  });

  it("drops only the sessions the account's checks refuse, without retrying them", async () => {
    const b = backend();
    b.refusePractice = ["bad"];
    const sync = new CloudSync(client(b), USER);
    sync.practice(practiceSession("good", 30));
    sync.practice(practiceSession("bad", 30));
    await vi.advanceTimersByTimeAsync(2000);
    // The refused batch goes again one session at a time.
    expect(b.calls).toEqual(Array(3).fill("upsert practice_sessions"));
    expect(b.upserts).toEqual([
      ["practice_sessions", [{ user_id: USER, ...practiceRow("good", 30) }]],
    ]);
    expect(sync.pending).toBe(false);
    expect(sync.error).toBe("");
    await vi.advanceTimersByTimeAsync(20000);
    expect(b.calls).toHaveLength(3);
  });

  it("keeps a session queued when its own retry fails for another reason", async () => {
    const b = backend();
    b.refusePractice = ["bad"];
    b.failWrites = true;
    const sync = new CloudSync(client(b), USER);
    sync.practice(practiceSession("good", 30));
    sync.practice(practiceSession("bad", 30));
    await vi.advanceTimersByTimeAsync(2000);
    // "bad" is refused for good; "good" only failed to send, so it waits.
    expect(
      Object.keys(read<{ practice?: object }>("pending", {}).practice ?? {}),
    ).toEqual(["good"]);
    expect(sync.error).toMatch(/Retrying/);
    b.failWrites = false;
    await vi.advanceTimersByTimeAsync(15000);
    expect(b.upserts).toEqual([
      ["practice_sessions", [{ user_id: USER, ...practiceRow("good", 30) }]],
    ]);
    expect(sync.pending).toBe(false);
  });

  it("loads a queue saved before practice synced", async () => {
    const b = backend();
    write("owner", USER);
    write("pending", { owner: USER, progress: { song: { best: 5 } } });
    const sync = new CloudSync(client(b), USER);
    await sync.pull();
    sync.practice(practiceSession("s", 30));
    await vi.advanceTimersByTimeAsync(2000);
    expect(b.upserts.map(([table]) => table)).toEqual([
      "progress",
      "practice_sessions",
    ]);
  });

  it("hands its practice off along with its progress", async () => {
    const b = backend();
    const sync = new CloudSync(client(b), USER);
    sync.detach();
    sync.practice(practiceSession("s", 30));
    b.failLabels = ["upsert practice_sessions"];
    const handing = sync.handOff();
    await vi.advanceTimersByTimeAsync(0);
    b.failLabels = [];
    await vi.advanceTimersByTimeAsync(15000);
    await handing;
    expect(b.upserts).toEqual([
      ["practice_sessions", [{ user_id: USER, ...practiceRow("s", 30) }]],
    ]);
  });

  it("hands off only the sessions the account takes", async () => {
    const b = backend();
    b.refusePractice = ["bad"];
    const sync = new CloudSync(client(b), USER);
    sync.detach();
    sync.practice(practiceSession("good", 30));
    sync.practice(practiceSession("bad", 30));
    await sync.handOff();
    await vi.advanceTimersByTimeAsync(20000);
    expect(b.upserts).toEqual([
      ["practice_sessions", [{ user_id: USER, ...practiceRow("good", 30) }]],
    ]);
    expect(b.calls).toHaveLength(3);
  });

  it("sends this browser's sessions before signing out from a failed load", async () => {
    const b = backend();
    write("owner", USER);
    write("practice:earlier", practiceSession("earlier", 300));
    b.failReads = true;
    const api = client(b);
    const sync = new CloudSync(api, USER);
    await expect(sync.pull()).rejects.toBeTruthy();
    b.failWrites = true;
    // Its only copy: signing out asks first.
    await expect(sync.signOut()).rejects.toBeInstanceOf(UnsentChangesError);
    expect(read("practice:earlier", null)).not.toBeNull();
    b.failWrites = false;
    await sync.signOut();
    expect(b.upserts).toEqual([
      [
        "practice_sessions",
        [{ user_id: USER, ...practiceRow("earlier", 300) }],
      ],
    ]);
    expect(read("practice:earlier", null)).toBeNull();
  });
});
