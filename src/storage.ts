import { SPEED_PERCENT, type Mode } from "./engine";
import {
  DEFAULT_PIANO_SOUND,
  normalizePianoSound,
  type PianoVoices,
} from "./pianoSound";
/** Daily practice goals to choose from, in minutes. */
export const DAILY_GOAL_CHOICES = [5, 10, 15, 20, 30];
export const LEARNER_NAME_MAX = 40;
export interface Settings {
  mode: Mode;
  speed: number;
  left: boolean;
  right: boolean;
  /** The teacher duet plays along, for songs that have one. */
  duet: boolean;
  /** A metronome clicks each beat, after a count-in, outside Wait for me. */
  click: boolean;
  tolerance: number;
  names: boolean;
  selected: string;
  ambience: number;
  /** The optional Accurate-Salamander voices that play. */
  pianoVoices: PianoVoices;
  /** Who practices here, for the calendar's praise; may be blank. */
  learnerName: string;
  /**
   * Whether the name was ever set, here or from the account, so a name
   * cleared on purpose stays blank rather than taking the account's again.
   */
  learnerNameChosen: boolean;
  /** Minutes of practice that earn a day its star. */
  dailyGoalMinutes: number;
}
export interface Progress {
  /** Where practice stands, in quarter-note beats. */
  beat: number;
  best: number;
  attempts: number;
  updated: string;
  assignments: Record<number, string>;
  loopEnabled: boolean;
  /**
   * The passage, in quarter-note beats. A null end runs to the song's end,
   * wherever a tempo change puts it.
   */
  loopBeats: [number, number | null] | null;
  /** The song version (see songVersion()) that `beat` and `loopBeats` count. */
  version: string;
}
export const defaults: Settings = {
  mode: "wait",
  speed: 1,
  left: true,
  right: true,
  duet: false,
  click: false,
  tolerance: 0.22,
  names: true,
  selected: "cadence-ode-to-joy-v1",
  ambience: DEFAULT_PIANO_SOUND.ambience,
  pianoVoices: { ...DEFAULT_PIANO_SOUND.voices },
  learnerName: "",
  learnerNameChosen: false,
  dailyGoalMinutes: 5,
};
const storageKey = (key: string) => `cadence:${key}`;
export function read<T>(key: string, fallback: T): T {
  try {
    return (
      JSON.parse(localStorage.getItem(storageKey(key)) || "null") ?? fallback
    );
  } catch {
    return fallback;
  }
}
export function write(key: string, value: unknown) {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
/** Every stored value whose key starts with `prefix`, skipping unreadable ones. */
export function readAll(prefix: string): unknown[] {
  const values: unknown[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(storageKey(prefix))) continue;
      try {
        values.push(JSON.parse(localStorage.getItem(key) || "null"));
      } catch {}
    }
  } catch {}
  return values;
}
/**
 * Call `onChange` when another tab changes a stored value whose key starts
 * with `prefix`, or clears storage. Returns a function that stops watching.
 */
export function watchStored(prefix: string, onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const listener = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(storageKey(prefix)))
      onChange();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
/** Returns false when browser storage is blocked. */
export function remove(key: string) {
  try {
    localStorage.removeItem(storageKey(key));
    return true;
  } catch {
    return false;
  }
}
/** Every song's saved progress on this browser, unvalidated, for account sync. */
export function localProgress() {
  const saved: { id: string; progress: Partial<Progress> }[] = [];
  try {
    const prefix = storageKey("progress:");
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const progress = read<Partial<Progress> | null>(`progress:${id}`, null);
      if (progress && typeof progress === "object")
        saved.push({ id, progress });
    }
  } catch {}
  return saved;
}
export function settings(): Settings {
  const saved = read<Partial<Settings>>("settings", {}),
    s = { ...defaults, ...(saved && typeof saved === "object" ? saved : {}) };
  const sound = normalizePianoSound({
    ambience: s.ambience,
    voices: s.pianoVoices,
  });
  return {
    mode: ["listen", "wait", "rhythm"].includes(s.mode)
      ? s.mode
      : defaults.mode,
    // Older saves used 5% steps; snap them onto the slider's steps.
    speed: Number.isFinite(s.speed)
      ? (Math.round(
          Math.max(
            SPEED_PERCENT.min,
            Math.min(SPEED_PERCENT.max, s.speed * 100),
          ) / SPEED_PERCENT.step,
        ) *
          SPEED_PERCENT.step) /
        100
      : defaults.speed,
    tolerance: Number.isFinite(s.tolerance)
      ? Math.max(0.08, Math.min(0.35, s.tolerance))
      : defaults.tolerance,
    left: !!s.left,
    right: !!s.right,
    duet: !!s.duet,
    click: !!s.click,
    names: !!s.names,
    selected: typeof s.selected === "string" ? s.selected : defaults.selected,
    ambience: sound.ambience,
    pianoVoices: sound.voices,
    learnerName:
      typeof s.learnerName === "string"
        ? s.learnerName.slice(0, LEARNER_NAME_MAX)
        : "",
    learnerNameChosen: s.learnerNameChosen === true,
    dailyGoalMinutes: DAILY_GOAL_CHOICES.includes(s.dailyGoalMinutes)
      ? s.dailyGoalMinutes
      : defaults.dailyGoalMinutes,
  };
}
/**
 * A song's saved progress, for `version` of the song (see songVersion()),
 * which is `beats` quarter-note beats long.
 */
export function progress(id: string, version: string, beats: number): Progress {
  const raw = read<Partial<Progress>>(`progress:${id}`, {}),
    p = raw && typeof raw === "object" ? raw : {};
  // Beats of other notes, or seconds from before versions were saved, would
  // put the position and passage on the wrong bars: they start over.
  const current = p.version === version,
    loop = current ? p.loopBeats : null;
  return {
    beat:
      current && Number.isFinite(p.beat)
        ? Math.max(0, Math.min(beats, p.beat!))
        : 0,
    best: Number.isFinite(p.best) ? Math.max(0, Math.min(100, p.best!)) : 0,
    attempts: Number.isFinite(p.attempts)
      ? Math.max(0, Math.floor(p.attempts!))
      : 0,
    updated: typeof p.updated === "string" ? p.updated : "",
    assignments:
      p.assignments && typeof p.assignments === "object" ? p.assignments : {},
    loopEnabled: typeof p.loopEnabled === "boolean" ? p.loopEnabled : true,
    loopBeats:
      Array.isArray(loop) &&
      loop.length === 2 &&
      Number.isFinite(loop[0]) &&
      loop[0] >= 0 &&
      loop[0] < beats &&
      (loop[1] === null || (Number.isFinite(loop[1]) && loop[1] > loop[0]))
        ? [loop[0], loop[1] === null ? null : Math.min(beats, loop[1])]
        : null,
    version,
  };
}
/**
 * Forget the signed-in account's settings, progress, practice sessions and
 * upload queue on this browser, such as at sign-out.
 */
export function clearAccountData() {
  // Only what the account holds. It keeps practice sessions too, so the
  // calendar comes back with the next sign-in, on any device.
  const account = (key: string) =>
    ["settings", "owner", "pending"].includes(key) ||
    key.startsWith("progress:") ||
    key.startsWith("practice:");
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key?.startsWith(storageKey("")) &&
        account(key.slice(storageKey("").length))
      )
        keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
}
