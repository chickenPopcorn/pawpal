import { readAll, remove, watchStored, write } from "./storage";

/** Without a key press for this long, nobody is playing, so time stops counting. */
export const IDLE_SECONDS = 15;
/** How many days of sessions the browser keeps. */
export const HISTORY_DAYS = 92;
/** A pause this long ends a session; playing again starts a new one. */
const SESSION_GAP_MS = 30 * 60 * 1000;

/** Playing time from one page visit on one local calendar day. */
export interface PracticeSession {
  id: string;
  /** The local calendar day, YYYY-MM-DD. */
  day: string;
  startedAt: string;
  /** Whole seconds of playing. */
  seconds: number;
  /** Seconds per song id. */
  songs: Record<string, number>;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** The local calendar day of `date`, as YYYY-MM-DD. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** The day `count` days after `day` (before, when negative). */
export function addDays(day: string, count: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + count));
}

const isSession = (value: unknown): value is PracticeSession => {
  const s = value as PracticeSession;
  return (
    !!s &&
    typeof s.id === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s.day) &&
    typeof s.startedAt === "string" &&
    Number.isSafeInteger(s.seconds) &&
    s.seconds >= 0 &&
    !!s.songs &&
    typeof s.songs === "object" &&
    !Array.isArray(s.songs)
  );
};
/**
 * Each session has its own storage key, written only by the tab that plays
 * it, so tabs saving at the same moment cannot overwrite each other.
 */
const sessionKey = (id: string) => `practice:${id}`;
/** The sessions saved on this browser, skipping any that are malformed. */
export function storedSessions(): PracticeSession[] {
  return readAll(sessionKey("")).filter(isSession);
}
/** Call `onChange` when another tab saves or removes a session. */
export function watchSessions(onChange: () => void) {
  return watchStored(sessionKey(""), onChange);
}

/**
 * Days in a row with at least `goal` seconds, ending today, or yesterday if
 * today has not met it yet.
 */
export function streak(
  totals: ReadonlyMap<string, number>,
  today: string,
  goal: number,
) {
  const met = (day: string) => (totals.get(day) ?? 0) >= goal;
  let day = met(today) ? today : addDays(today, -1);
  let count = 0;
  while (met(day)) {
    count++;
    day = addDays(day, -1);
  }
  return count;
}

/**
 * Adds up practice time into sessions and keeps them in browser storage. The
 * studio reports playing time as it happens; commit() saves the session in
 * progress.
 */
export class PracticeLog {
  private sessions = new Map<string, PracticeSession>();
  /** Sessions this page started. Other tabs save their own. */
  private own = new Set<string>();
  private current: PracticeSession | null = null;
  /** Unrounded seconds of the session in progress. */
  private exact = 0;
  /** A Map, so a song id such as `__proto__` is an ordinary key. */
  private songExact = new Map<string, number>();
  private lastAdd = 0;
  /** Changes whenever a day's total does, so views can skip work. */
  revision = 0;

  /**
   * `saved` hears each session commit() saves, for the account to keep: it
   * is called even when browser storage refused the session.
   */
  constructor(
    private clock: () => Date = () => new Date(),
    private saved: (session: PracticeSession) => void = () => {},
  ) {
    for (const session of storedSessions())
      this.sessions.set(session.id, session);
  }

  today() {
    return localDay(this.clock());
  }

  /** Count `seconds` of playing `songId`. */
  add(seconds: number, songId: string) {
    if (!(seconds > 0)) return;
    const now = this.clock();
    const day = localDay(now);
    if (
      !this.current ||
      this.current.day !== day ||
      now.getTime() - this.lastAdd > SESSION_GAP_MS
    ) {
      this.commit();
      this.current = {
        id: crypto.randomUUID(),
        day,
        startedAt: now.toISOString(),
        seconds: 0,
        songs: {},
      };
      this.exact = 0;
      this.songExact = new Map();
      this.own.add(this.current.id);
      this.sessions.set(this.current.id, this.current);
    }
    this.lastAdd = now.getTime();
    const before = Math.floor(this.exact);
    this.exact += seconds;
    this.songExact.set(songId, (this.songExact.get(songId) ?? 0) + seconds);
    if (Math.floor(this.exact) !== before) this.revision++;
  }

  /**
   * Save the session in progress, if it gained a whole second since the last
   * commit. Returns false if browser storage refused it.
   */
  commit(): boolean {
    const session = this.current;
    if (!session || Math.floor(this.exact) === session.seconds) return true;
    const updated: PracticeSession = {
      ...session,
      seconds: Math.floor(this.exact),
      songs: Object.fromEntries(
        [...this.songExact].map(([id, s]) => [id, Math.floor(s)]),
      ),
    };
    this.current = updated;
    const saved = write(sessionKey(updated.id), updated);
    this.saved(updated);
    const sessions = this.withOtherTabs();
    sessions.set(updated.id, updated);
    this.sessions = sessions;
    // Keep HISTORY_DAYS days, today included. Older sessions belong to no
    // open tab, so removing their keys cannot race a save.
    const oldest = addDays(updated.day, 1 - HISTORY_DAYS);
    for (const [id, s] of this.sessions)
      if (s.day < oldest) {
        this.sessions.delete(id);
        remove(sessionKey(id));
      }
    return saved;
  }

  /**
   * Other tabs' latest sessions from storage, with this tab's own copies,
   * which are newest even when storage refused one.
   */
  private withOtherTabs() {
    const sessions = new Map<string, PracticeSession>();
    for (const s of storedSessions())
      if (!this.own.has(s.id)) sessions.set(s.id, s);
    for (const id of this.own) {
      const s = this.sessions.get(id);
      if (s) sessions.set(id, s);
    }
    return sessions;
  }

  /**
   * Take in sessions another tab saved, such as when it reaches the goal
   * while this tab sits idle. Returns true if a day's total changed.
   */
  refresh(): boolean {
    const before = JSON.stringify([...this.totals()]);
    this.sessions = this.withOtherTabs();
    if (JSON.stringify([...this.totals()]) === before) return false;
    this.revision++;
    return true;
  }

  /** Seconds practiced on each day, the session in progress included. */
  totals(): Map<string, number> {
    const totals = new Map<string, number>();
    for (const s of this.sessions.values()) {
      const seconds = s === this.current ? Math.floor(this.exact) : s.seconds;
      totals.set(s.day, (totals.get(s.day) ?? 0) + seconds);
    }
    return totals;
  }
}
