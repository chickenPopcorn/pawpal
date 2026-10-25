import type { SupabaseClient } from "@supabase/supabase-js";
import {
  clearAccountData,
  localProgress,
  read,
  remove,
  write,
  type Progress,
  type Settings,
} from "./storage";
import {
  addDays,
  HISTORY_DAYS,
  localDay,
  storedSessions,
  type PracticeSession,
} from "./practiceLog";

/** A burst of saves within this time becomes one upload. */
const DEBOUNCE_MS = 2000;
/** A failed upload is tried again after this long. */
const RETRY_MS = 15000;
/** A request that takes longer than this is aborted and treated as failed. */
const TIMEOUT_MS = 30000;
const NO_RESPONSE = "The account service did not respond.";
const RETRYING = "Changes could not be saved to your account. Retrying.";
const FULL_ACCOUNT =
  "This account has progress for 200 songs, its limit, so progress for new songs is not saved.";
/**
 * Postgres refused a row a check rejects: for progress, the progress_quota
 * trigger; for practice, a session the practice_sessions checks never take.
 */
const CHECK_VIOLATION = "23514";
/** How many times handOff() tries, RETRY_MS apart: about an hour. */
const HANDOFF_ATTEMPTS = 240;
/** Songs one account keeps progress for (see the progress_quota trigger). */
const MAX_SONGS = 200;
const STORAGE_FULL =
  "This browser's storage is full, so changes are uploading now. Free up site storage to keep them safe.";
/** The Data API returns at most this many rows per request (Supabase's default). */
const PAGE = 1000;

/**
 * A record's content for comparison: keys sorted, and without `updated`, which
 * every save rewrites even when nothing else changed.
 */
function canon(value: unknown): string {
  const sort = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sort)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [
                key,
                sort((item as Record<string, unknown>)[key]),
              ]),
          )
        : item;
  const { updated: _updated, ...rest } = (value ?? {}) as Record<
    string,
    unknown
  >;
  return JSON.stringify(sort(rest));
}

/** This browser cannot store the account's data, so the studio cannot open. */
export class BrowserStorageError extends Error {
  constructor() {
    super(
      "This browser is blocking site storage, so your account cannot load here. Allow site data for this page and try again.",
    );
  }
}

/** Signing out now would lose changes the account has not received. */
export class UnsentChangesError extends Error {
  constructor() {
    super("Some of your practice has not reached your account yet.");
  }
}

/** Run a request with a time limit. Past it, the request is aborted. */
async function timed<T>(
  start: (signal: AbortSignal) => PromiseLike<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(NO_RESPONSE));
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      Promise.resolve(start(controller.signal)),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Changes waiting to upload, kept in browser storage (`pending`) so a reload
 * or a failed request does not lose them. Only one tab runs the studio (see
 * src/studioClaim.ts), so no other tab writes them meanwhile.
 */
interface Queue {
  owner: string;
  settings?: Settings;
  progress: Record<string, Progress>;
  /** Practice sessions by id. Missing in a queue saved before they synced. */
  practice?: Record<string, PracticeSession>;
}

/** A practice_sessions row as the Data API returns it. */
interface PracticeRow {
  id: string;
  day: string;
  started_at: string;
  seconds: number;
  songs: Record<string, number>;
}

/** What the studio reports so the signed-in account stays current. */
export interface SyncHooks {
  settings(settings: Settings): void;
  /** `loaded`: the save made as the song opens, before any practice. */
  progress(songId: string, progress: Progress, loaded?: boolean): void;
  /** A practice session gained time. */
  practice(session: PracticeSession): void;
}

/**
 * Keeps one user's settings, practice progress and practice time in their
 * Supabase account. The account is the record, and it merges each upload
 * (see the progress_merge trigger): the best score and the number of starts
 * only grow, so a late upload from one device never undoes practice from
 * another. Practice sessions only grow too (practice_sessions_never_shrink).
 * This browser keeps a copy for the next load, and a queue of changes to
 * upload.
 */
export class CloudSync implements SyncHooks {
  private queue: Queue;
  /** What the account holds, as far as this browser knows: no need to send it. */
  private syncedSettings = "";
  private syncedProgress = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private uploading: Promise<void> | null = null;
  private stopped = false;
  /** pull() finished: practice this browser has but the account lacks is queued. */
  private loaded = false;
  /** Another tab owns the studio and the stored queue; see detach(). */
  private detached = false;
  /**
   * The account refused a new song for its 200-song limit this session. It
   * is then full, so the notice stays.
   */
  private full = false;
  error = "";
  /** Called when error changes. */
  onChange = () => {};

  constructor(
    private client: SupabaseClient,
    readonly userId: string,
  ) {
    const stored = read<Queue | null>("pending", null);
    this.queue =
      stored?.owner === userId && stored.progress
        ? { ...stored, practice: stored.practice ?? {} }
        : { owner: userId, progress: {}, practice: {} };
  }

  private get queuedPractice() {
    return (this.queue.practice ??= {});
  }

  private setError(error: string) {
    if (error === this.error) return;
    this.error = error;
    this.onChange();
  }

  /** Whether changes are waiting to upload. */
  get pending() {
    return (
      !!this.queue.settings ||
      Object.keys(this.queue.progress).length > 0 ||
      Object.keys(this.queuedPractice).length > 0
    );
  }

  /**
   * Load the account into this browser before the studio opens. Changes left
   * waiting by an earlier visit upload first, so the account includes them.
   */
  async pull() {
    const store = (key: string, value: unknown) => {
      if (!write(key, value)) throw new BrowserStorageError();
    };
    // Another account's settings and progress must not show in, or upload
    // to, this one.
    const owner = read<string | null>("owner", null);
    if (owner && owner !== this.userId) clearAccountData();
    // The first account on this browser takes what was saved here before
    // sign-in existed, where the account has nothing for it.
    const adopting = !owner;
    if (this.pending) {
      await this.flush();
      // A full account drops the new songs and leaves the rest to try again.
      if (this.pending && this.error === FULL_ACCOUNT) await this.flush();
      if (this.pending) throw new Error(RETRYING);
    }
    // The calendar keeps HISTORY_DAYS days, today included.
    const since = addDays(localDay(new Date()), 1 - HISTORY_DAYS);
    const [settings, rows, practiceRows] = await Promise.all([
      timed(() => this.client.from("settings").select("data").maybeSingle()),
      this.allProgress(),
      this.allPractice(since),
    ]);
    if (settings.error) throw settings.error;
    // A newer sign-in replaced this one while it loaded: change nothing.
    if (this.stopped) throw new Error("This sign-in was replaced.");

    const localSettings = read<Settings | null>("settings", null);
    if (settings.data) {
      this.syncedSettings = canon(settings.data.data);
      store("settings", settings.data.data);
    } else if (localSettings) this.queue.settings = localSettings;

    const remote = new Map(rows.map((row) => [row.song_id, row.data]));
    const missing = localProgress().filter(({ id }) => !remote.has(id));
    // A scan over several pages is no snapshot: a row another device added
    // behind it meanwhile would look missing. Ask for those songs directly.
    if (!adopting && missing.length && rows.length >= PAGE) {
      const found = await timed(() =>
        this.client
          .from("progress")
          .select("song_id, data")
          .in(
            "song_id",
            missing.map(({ id }) => id),
          ),
      );
      if (found.error) throw found.error;
      if (this.stopped) throw new Error("This sign-in was replaced.");
      for (const row of found.data as typeof rows)
        remote.set(row.song_id, row.data);
    }
    // Adoption fills only the room the account has left.
    let room = MAX_SONGS - remote.size;
    for (const { id, progress } of missing) {
      if (remote.has(id)) continue;
      if (adopting) {
        if (room-- > 0) this.queue.progress[id] = progress as Progress;
        continue;
      }
      // Not in the account, so not this account's.
      if (!remove(`progress:${id}`)) throw new BrowserStorageError();
    }
    for (const [id, data] of remote) {
      this.syncedProgress.set(id, canon(data));
      store(`progress:${id}`, data);
    }

    // Practice: each session as its larger copy, the account's or this
    // browser's. Sessions only this browser has, such as ones played before
    // the account kept practice, upload.
    const account = new Map(practiceRows.map((row) => [row.id, row]));
    for (const session of storedSessions()) {
      if (session.day < since) continue;
      const row = account.get(session.id);
      if (!row || row.seconds < session.seconds)
        this.queuedPractice[session.id] = session;
    }
    for (const row of practiceRows) {
      const local = read<PracticeSession | null>(`practice:${row.id}`, null);
      if (local && local.seconds >= row.seconds) continue;
      store(`practice:${row.id}`, {
        id: row.id,
        day: row.day,
        startedAt: row.started_at,
        seconds: row.seconds,
        songs: row.songs,
      } satisfies PracticeSession);
    }
    // The queue goes first: once the owner is recorded, the next pull no
    // longer adopts, and only the queue would keep what this one adopted.
    if (!this.savePending()) throw new BrowserStorageError();
    store("owner", this.userId);
    this.loaded = true;
    if (this.pending) this.schedule(0);
  }

  /** Every progress row of the account, a page at a time by song id. */
  private async allProgress() {
    const rows: { song_id: string; data: Partial<Progress> }[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await timed(() => {
        const query = this.client
          .from("progress")
          .select("song_id, data")
          .order("song_id")
          .limit(PAGE);
        return after === null ? query : query.gt("song_id", after);
      });
      if (page.error) throw page.error;
      const data = page.data as typeof rows;
      rows.push(...data);
      if (data.length < PAGE || this.stopped) return rows;
      after = data[data.length - 1].song_id;
    }
  }

  /** The account's practice sessions from `since` on, a page at a time by id. */
  private async allPractice(since: string) {
    const rows: PracticeRow[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await timed(() => {
        const query = this.client
          .from("practice_sessions")
          .select("id, day, started_at, seconds, songs")
          .gte("day", since)
          .order("id")
          .limit(PAGE);
        return after === null ? query : query.gt("id", after);
      });
      if (page.error) throw page.error;
      const data = page.data as PracticeRow[];
      rows.push(...data);
      if (data.length < PAGE || this.stopped) return rows;
      after = data[data.length - 1].id;
    }
  }

  settings(settings: Settings) {
    if (this.stopped) return;
    if (!this.queue.settings && canon(settings) === this.syncedSettings) return;
    this.queue.settings = { ...settings };
    this.queued();
  }

  progress(songId: string, progress: Progress, loaded = false) {
    if (this.stopped) return;
    // Opening a song is not practice: its save only says where it stands.
    if (loaded) {
      if (!this.syncedProgress.has(songId))
        this.syncedProgress.set(songId, canon(progress));
      return;
    }
    if (
      !(songId in this.queue.progress) &&
      canon(progress) === this.syncedProgress.get(songId)
    )
      return;
    this.queue.progress[songId] = { ...progress };
    this.queued();
  }

  practice(session: PracticeSession) {
    if (this.stopped) return;
    this.queuedPractice[session.id] = { ...session };
    this.queued();
  }

  /** Keep the queue in browser storage. False if it is full. */
  private savePending(): boolean {
    if (this.detached) return true;
    if (this.pending) return write("pending", this.queue);
    remove("pending");
    return true;
  }

  /**
   * Schedule the queued change's upload. If browser storage cannot hold the
   * queue, a reload before the upload lands would lose it, so upload at once
   * and say so.
   */
  private queued() {
    if (this.detached) return;
    if (this.savePending()) return this.schedule();
    this.setError(STORAGE_FULL);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  private schedule(delay = DEBOUNCE_MS) {
    if (this.stopped || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  /** Upload what is queued now. A failure keeps it queued and retries later. */
  async flush(): Promise<void> {
    // One upload at a time: a newer change never overtakes an older request.
    while (this.uploading) await this.uploading;
    if (!this.pending || this.stopped) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const settings = this.queue.settings,
      progress = Object.entries(this.queue.progress),
      practice = Object.values(this.queuedPractice);
    this.uploading = (async () => {
      // Aborting at the time limit settles the request, so it cannot land
      // after the retry that replaces it.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let quotaReached = false;
      const sent = async (
        request:
          PromiseLike<{ error: { code?: string } | null }> | false | undefined,
        refused = () => {},
      ) => {
        if (!request) return true;
        try {
          const { error } = await request;
          if (error?.code === CHECK_VIOLATION) refused();
          return !error;
        } catch {
          return false;
        }
      };
      const [settingsOk, progressOk, practiceSent] = await Promise.all([
        sent(
          settings &&
            this.client
              .from("settings")
              .upsert({ user_id: this.userId, data: settings })
              .abortSignal(controller.signal),
        ),
        sent(
          progress.length > 0 &&
            this.client
              .from("progress")
              .upsert(
                progress.map(([song_id, data]) => ({
                  user_id: this.userId,
                  song_id,
                  data,
                })),
              )
              .abortSignal(controller.signal),
          () => (quotaReached = true),
        ),
        this.sendPractice(practice, controller.signal),
      ]);
      clearTimeout(timer);
      // What landed leaves the queue, unless a newer save replaced it since.
      if (settings && settingsOk) {
        this.syncedSettings = canon(settings);
        if (this.queue.settings === settings) delete this.queue.settings;
      }
      for (const session of practiceSent.settled)
        if (this.queuedPractice[session.id] === session)
          delete this.queuedPractice[session.id];
      if (progressOk)
        for (const [id, data] of progress) {
          this.syncedProgress.set(id, canon(data));
          if (this.queue.progress[id] === data) delete this.queue.progress[id];
        }
      // The account is full: one new song's refusal fails the whole upload,
      // so drop the new songs and let saves of songs it has go through. Ask
      // the account which songs it has: before pull() reads it, this browser
      // does not know.
      else if (quotaReached) {
        // One refused insert undoes the whole upload, so some new songs may
        // still fit: keep as many as the account has room for, in order.
        const ids = progress.map(([id]) => id);
        const [existing, total] = await Promise.all([
          timed(() =>
            this.client.from("progress").select("song_id").in("song_id", ids),
          ),
          timed(() =>
            this.client
              .from("progress")
              .select("song_id", { count: "exact", head: true }),
          ),
        ]).catch(() => [null, null] as const);
        if (
          existing &&
          !existing.error &&
          total &&
          !total.error &&
          total.count !== null
        ) {
          const have = new Set(
            (existing.data as { song_id: string }[]).map((row) => row.song_id),
          );
          let room = MAX_SONGS - total.count;
          for (const id of ids)
            if (!have.has(id) && room-- <= 0) delete this.queue.progress[id];
        } else quotaReached = false;
      }
      if (this.stopped) return;
      this.savePending();
      if (quotaReached) {
        this.full = true;
        this.setError(FULL_ACCOUNT);
        if (this.pending) this.schedule(0);
      } else if (settingsOk && progressOk && practiceSent.ok)
        // Saving the songs it has does not save the new ones it refused.
        this.setError(this.full ? FULL_ACCOUNT : "");
      else {
        this.setError(RETRYING);
        this.schedule(RETRY_MS);
      }
    })().finally(() => {
      this.uploading = null;
    });
    await this.uploading;
  }

  /**
   * Another tab took the studio over, and with it the queue in browser
   * storage. Changes from here on stay in memory for handOff() to send.
   */
  detach() {
    this.detached = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * After detach(), send this tab's queued progress and practice once, then
   * stop. Browser storage may have had no room for them, and the server
   * merges progress and keeps the larger copy of a session, so they can land
   * in any order. Settings are left to the other tab, which has the stored
   * queue: an old copy from here could undo a newer choice there.
   */
  async handOff() {
    while (this.uploading) await this.uploading;
    this.stop();
    const progress = Object.entries(this.queue.progress);
    let practice = Object.values(this.queuedPractice);
    if (!progress.length && !practice.length) return;
    // Only this tab holds these changes, so keep trying while it is open.
    for (let attempt = 0; attempt < HANDOFF_ATTEMPTS; attempt++) {
      if (attempt)
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      try {
        const [saved, played] = await Promise.all([
          progress.length &&
            timed((signal) =>
              this.client
                .from("progress")
                .upsert(
                  progress.map(([song_id, data]) => ({
                    user_id: this.userId,
                    song_id,
                    data,
                  })),
                )
                .abortSignal(signal),
            ),
          timed((signal) => this.sendPractice(practice, signal)),
        ]);
        // What landed is not sent again.
        if (saved && !saved.error) progress.length = 0;
        const settled = new Set(played.settled);
        practice = practice.filter((session) => !settled.has(session));
        if (!progress.length && !practice.length) return;
      } catch {}
    }
  }

  /**
   * Upload practice sessions. One refused row fails the whole upsert, so a
   * refused batch goes again one session at a time, and only a session the
   * account's checks refuse on its own is given up: it could never land, and
   * the calendar on this browser still shows it. `settled` is what landed or
   * was given up; `ok` says every request was answered.
   */
  private async sendPractice(
    sessions: PracticeSession[],
    signal: AbortSignal,
  ): Promise<{ settled: PracticeSession[]; ok: boolean }> {
    const upsert = async (batch: PracticeSession[]) => {
      try {
        const { error } = await this.client
          .from("practice_sessions")
          .upsert(batch.map((session) => this.practiceRow(session)))
          .abortSignal(signal);
        if (!error) return "landed";
        return error.code === CHECK_VIOLATION ? "refused" : "failed";
      } catch {
        return "failed";
      }
    };
    if (!sessions.length) return { settled: [], ok: true };
    const whole = await upsert(sessions);
    if (whole === "failed") return { settled: [], ok: false };
    if (whole === "landed" || sessions.length === 1)
      return { settled: sessions, ok: true };
    const each = await Promise.all(
      sessions.map((session) => upsert([session])),
    );
    return {
      settled: sessions.filter((_, i) => each[i] !== "failed"),
      ok: each.every((result) => result !== "failed"),
    };
  }

  private practiceRow(session: PracticeSession) {
    return {
      id: session.id,
      user_id: this.userId,
      day: session.day,
      started_at: session.startedAt,
      seconds: session.seconds,
      songs: session.songs,
    };
  }

  /** Stop syncing, such as when the session ended elsewhere. Nothing more is sent. */
  stop() {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Upload what is queued, then sign out this browser and clear its copy of
   * the account. Close the studio first, so its final save is in the upload.
   * Throws UnsentChangesError, still signed in, if some changes could not
   * upload, unless `force` says to drop them; throws, still signed in, if
   * Supabase cannot end the session.
   */
  async signOut({ force = false } = {}) {
    // Before pull() finished, such as from a failed load, this browser cannot
    // tell which of its sessions the account has, and sign-out clears them:
    // send them all first. The account keeps the larger copy of each.
    if (!force && !this.loaded && !this.stopped) {
      const since = addDays(localDay(new Date()), 1 - HISTORY_DAYS);
      for (const session of storedSessions())
        if (session.day >= since) this.queuedPractice[session.id] ??= session;
      this.savePending();
    }
    // A forced sign-out follows one that already tried to upload.
    if (!force) await this.flush();
    if (this.pending && !force) throw new UnsentChangesError();
    // No time limit: the request cannot be cancelled, so a timeout could
    // report failure and then sign out later anyway. Only this browser signs
    // out; other devices keep their sessions.
    const { error } = await this.client.auth.signOut({ scope: "local" });
    if (error) throw error;
    this.stop();
    clearAccountData();
  }
}
