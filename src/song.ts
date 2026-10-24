import { parseMidi } from "midi-file";
import { createBeatClock, lastIndexAtOrBefore } from "./timeline";
import type { SongBook } from "./library";
export type Hand = "left" | "right" | "off";
export type Finger = 1 | 2 | 3 | 4 | 5;
export interface Note {
  id: string;
  pitch: number;
  velocity: number;
  start: number;
  end: number;
  soundEnd: number;
  track: number;
  channel: number;
  finger?: Finger;
  fingerHand?: "left" | "right";
  /** Written length in quarter-note beats, before articulation shortens playback. */
  notatedBeats?: number;
  staccato?: boolean;
}
/** A sustain-pedal press on one MIDI channel: down at `start`, up at `end`. */
export interface PedalSpan {
  channel: number;
  start: number;
  end: number;
  /** The file ends with the pedal down: `end` is the file's end, not a lift. */
  open?: true;
}
export interface Track {
  id: number;
  name: string;
  hand: Hand;
  count: number;
}
export interface Tempo {
  tick: number;
  microseconds: number;
}
export interface TimeSignature {
  tick: number;
  numerator: number;
  denominator: number;
}
export interface Song {
  id: string;
  title: string;
  notes: Note[];
  tracks: Track[];
  duration: number;
  tempos: Tempo[];
  ppq: number;
  timeSignatures?: TimeSignature[];
  /**
   * Sustain-pedal presses (CC64 at or above 64), in time order. Missing for
   * songs without pedal data, including songs saved before it was recorded.
   */
  pedals?: PedalSpan[];
  /**
   * A teacher part that plays along with Duet on. It is kept apart from
   * `notes` and `tracks`, so it is never scored, waited for or fingered; the
   * waterfall shows it faintly behind them.
   */
  duet?: {
    notes: Note[];
    /** How many octaves the student part moves with it: negative is lower. */
    octaves: number;
  };
  /** Legacy lesson bar length, in quarter-note beats. */
  beatsPerBar?: number;
  leadInBeats?: number;
  warnings: string[];
  source?: {
    composer: string;
    description: string;
    url: string;
    credit: string;
  };
  lesson?: {
    composer: string;
    description: string;
    level: string;
    bpm: number;
    handPositions: { left: string; right: string };
  };
  /** Set on songs from the shared library bucket. */
  library?: {
    book: SongBook;
    /**
     * URL of the song's MIDI file, for its Download button. Only a signed-in
     * request can read it (see signedInFetch).
     */
    midi?: string;
  };
}
export const fingerNames = ["", "thumb", "index", "middle", "ring", "little"];
export const suggestedFinger = (note: Note, hand: Hand) =>
  note.fingerHand === hand ? note.finger : undefined;
const MAX_NOTES = 50000;
const MAX_EVENTS = 500000;
const MAX_TRACKS = 256;
const NOTE_LIMIT_MESSAGE =
  "This MIDI file has more than 50,000 notes. Export a smaller passage for practice.";
/** Reject an oversized file before reading or parsing it. */
function checkMidiSize(bytes: number) {
  if (bytes > 10 * 1024 * 1024)
    throw new Error("Please choose a MIDI file smaller than 10 MB.");
}

/** Count attacks without constructing parser events or normalized notes. */
function preflightTrack(
  bytes: Uint8Array,
  start: number,
  end: number,
  budget: { notes: number; events: number },
) {
  let cursor = start,
    runningStatus = 0,
    tick = 0;
  const malformed = () =>
    new Error("This MIDI file has malformed or incomplete track events.");
  const byte = () => {
    if (cursor >= end) throw malformed();
    return bytes[cursor++];
  };
  const variable = () => {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = byte();
      value = value * 128 + (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
    throw malformed();
  };
  while (cursor < end) {
    if (++budget.events > MAX_EVENTS)
      throw new Error(
        "This MIDI file has more than 500,000 events. Export a smaller passage for practice.",
      );
    tick += variable();
    if (!Number.isSafeInteger(tick) || tick > 2 ** 40)
      throw new Error("MIDI timeline is too long.");
    let status = byte();
    let first: number | undefined;
    if (status < 0x80) {
      if (!runningStatus) throw malformed();
      first = status;
      status = runningStatus;
    } else if (status < 0xf0) {
      runningStatus = status;
    } else {
      // SMF SysEx and meta messages have explicit variable-length payloads.
      const metaType = status === 0xff ? byte() : undefined;
      if (status !== 0xff) {
        if (status !== 0xf0 && status !== 0xf7) throw malformed();
        runningStatus = 0;
      }
      const length = variable();
      if (length > end - cursor) throw malformed();
      // midi-file uses a bit shift for the denominator: reject exponents that
      // would wrap there, and bound the smallest supported written note unit.
      if (
        metaType === 0x58 &&
        ((length !== 2 && length !== 4) ||
          !bytes[cursor] ||
          bytes[cursor + 1] > 10)
      )
        throw new Error("This MIDI file has an unsupported time signature.");
      cursor += length;
      continue;
    }
    first ??= byte();
    const type = status >> 4;
    const second = type === 0xc || type === 0xd ? undefined : byte();
    if (first >= 0x80 || (second !== undefined && second >= 0x80))
      throw malformed();
    if (type === 0x9 && second! > 0 && ++budget.notes > MAX_NOTES)
      throw new Error(NOTE_LIMIT_MESSAGE);
  }
}

/** Seconds at a MIDI tick. */
export function tempoConverter(ppq: number, changes: Tempo[]) {
  const clock = createBeatClock(ppq, changes);
  return (tick: number) => clock.time(tick / ppq);
}
/**
 * A short hash of the student part's notes: each pitch and the beat it starts
 * on. A tempo change or another MIDI resolution keeps it; a change to the
 * notes does not. Saved progress counts beats of one version (see
 * storage.progress()).
 */
export function songVersion(song: Song) {
  const ppq = song.ppq > 0 ? song.ppq : 480,
    clock = createBeatClock(ppq, song.tempos);
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  // Whole ticks, so float noise in the seconds cannot change the hash.
  const keys = song.notes
    .map((note) => [Math.round(clock.at(note.start) * ppq), note.pitch])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // 32-bit FNV-1a.
  let hash = 0x811c9dc5;
  for (const [tick, pitch] of keys) {
    // The beat as a fraction in lowest terms, the same at any resolution.
    const divisor = gcd(tick, ppq);
    for (const char of `${tick / divisor}/${ppq / divisor}:${pitch};`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
export function parseSong(bytes: Uint8Array, title: string, id: string): Song {
  checkMidiSize(bytes.length);
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "MThd")
    throw new Error("This is not a standard MIDI file (.mid).");
  // Validate chunk boundaries because permissive parsers may accept a truncated header.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 14 || view.getUint32(4) !== 6)
    throw new Error("This MIDI file is malformed or incomplete.");
  const declaredTracks = view.getUint16(10);
  if (declaredTracks > MAX_TRACKS)
    throw new Error(
      "This MIDI file has more than 256 tracks. Export a smaller selection of tracks for practice.",
    );
  let offset = 14;
  const budget = { notes: 0, events: 0 };
  for (let i = 0; i < declaredTracks; i++) {
    if (
      offset + 8 > bytes.length ||
      String.fromCharCode(...bytes.slice(offset, offset + 4)) !== "MTrk"
    )
      throw new Error("This MIDI file has a missing or malformed track.");
    const size = view.getUint32(offset + 4);
    const start = offset + 8;
    offset = start + size;
    if (offset > bytes.length)
      throw new Error("This MIDI file has an incomplete track.");
    preflightTrack(bytes, start, offset, budget);
  }
  if (!declaredTracks) throw new Error("This MIDI file has no tracks.");
  let midi;
  try {
    midi = parseMidi(bytes);
  } catch {
    throw new Error(
      "This MIDI file is malformed or incomplete. Try exporting it again.",
    );
  }
  if (midi.header.format === 2)
    throw new Error(
      "MIDI format 2 uses independent timelines. Export as format 0 or 1.",
    );
  if (midi.header.format !== 0 && midi.header.format !== 1)
    throw new Error("Unsupported MIDI format. Export as format 0 or 1.");
  if (midi.header.format === 0 && declaredTracks !== 1)
    throw new Error("A format 0 MIDI file must contain one track.");
  const ppq = midi.header.ticksPerBeat;
  if (!ppq)
    throw new Error(
      "SMPTE time division is not supported. Export with ticks per beat.",
    );
  const tempos: Tempo[] = [];
  const timeSignatures: TimeSignature[] = [];
  const warnings: string[] = [];
  const events = midi.tracks.map((track) => {
    let tick = 0;
    return track.map((e) => {
      if (!Number.isInteger(e.deltaTime) || e.deltaTime < 0)
        throw new Error("Malformed MIDI event timing.");
      tick += e.deltaTime;
      if (!Number.isSafeInteger(tick) || tick > 2 ** 40)
        throw new Error("MIDI timeline is too long.");
      if (e.type === "noteOn" || e.type === "noteOff") {
        if (
          !Number.isInteger(e.noteNumber) ||
          e.noteNumber < 0 ||
          e.noteNumber > 127 ||
          e.velocity < 0 ||
          e.velocity > 127
        )
          throw new Error("Malformed MIDI note data.");
      }
      if (e.type === "setTempo") {
        if (e.microsecondsPerBeat <= 0) throw new Error("Invalid MIDI tempo.");
        tempos.push({ tick, microseconds: e.microsecondsPerBeat });
      }
      if (e.type === "timeSignature")
        timeSignatures.push({
          tick,
          numerator: e.numerator,
          denominator: e.denominator,
        });
      return { e, tick };
    });
  });
  const time = tempoConverter(ppq, tempos);
  const notes: Note[] = [];
  const tracks = events.map((events, track) => {
    const active = new Map<
      string,
      { entries: { tick: number; velocity: number }[]; head: number }
    >();
    let count = 0;
    for (const { e, tick } of events) {
      if (e.type !== "noteOn" && e.type !== "noteOff") continue;
      const key = `${e.channel}:${e.noteNumber}`;
      if (e.type === "noteOn" && e.velocity > 0) {
        const q = active.get(key) || { entries: [], head: 0 };
        q.entries.push({ tick, velocity: e.velocity / 127 });
        active.set(key, q);
      } else {
        const q = active.get(key);
        if (!q || q.head >= q.entries.length) {
          warnings.push("Unpaired note-off ignored.");
          continue;
        }
        const first = q.entries[q.head++];
        if (q.head === q.entries.length) active.delete(key);
        if (notes.length >= MAX_NOTES) throw new Error(NOTE_LIMIT_MESSAGE);
        const n: Note = {
          id: `${track}-${count++}`,
          pitch: e.noteNumber,
          channel: e.channel,
          velocity: first.velocity,
          start: time(first.tick),
          end: time(tick),
          soundEnd: time(tick),
          track,
        };
        notes.push(n);
      }
    }
    const last = events.at(-1)?.tick || 0;
    for (const [key, q] of active)
      for (let i = q.head; i < q.entries.length; i++) {
        const n = q.entries[i];
        if (notes.length >= MAX_NOTES) throw new Error(NOTE_LIMIT_MESSAGE);
        const [channel, pitch] = key.split(":").map(Number);
        notes.push({
          id: `${track}-${count++}`,
          pitch,
          channel,
          velocity: n.velocity,
          start: time(n.tick),
          end: time(Math.max(last, n.tick + ppq / 4)),
          soundEnd: time(Math.max(last, n.tick + ppq / 4)),
          track,
        });
        warnings.push("Unclosed note ended at track boundary.");
      }
    const name = events.find((x) => x.e.type === "trackName")?.e;
    return {
      id: track,
      name:
        name?.type === "trackName"
          ? name.text.slice(0, 160)
          : `Track ${track + 1}`,
      hand: "off" as Hand,
      count,
    };
  });
  // Controllers are channel-wide in SMF, even when a different track owns them.
  const intervals = new Map<number, Omit<PedalSpan, "channel">[]>(),
    down = new Map<number, number>();
  const controls = events
    .flat()
    .filter((x) => x.e.type === "controller" && x.e.controllerType === 64)
    .sort((a, b) => a.tick - b.tick);
  const lastTick = events.reduce(
    (last, track) => Math.max(last, track.at(-1)?.tick || 0),
    0,
  );
  for (const { e, tick } of controls) {
    if (e.type !== "controller") continue;
    if (e.value >= 64) {
      if (!down.has(e.channel)) down.set(e.channel, time(tick));
    } else if (down.has(e.channel)) {
      const list = intervals.get(e.channel) || [];
      list.push({ start: down.get(e.channel)!, end: time(tick) });
      intervals.set(e.channel, list);
      down.delete(e.channel);
    }
  }
  for (const [channel, start] of down) {
    const list = intervals.get(channel) || [];
    list.push({ start, end: time(lastTick), open: true });
    intervals.set(channel, list);
  }
  for (const n of notes) {
    const list = intervals.get(n.channel) || [];
    const interval = list[lastIndexAtOrBefore(list, "start", n.end)];
    if (interval && n.end < interval.end) n.soundEnd = interval.end;
  }
  if (!notes.length)
    throw new Error("No playable notes were found in this MIDI file.");
  notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  const playable = tracks.filter((t) => t.count);
  if (playable.length === 1) playable[0].hand = "right";
  const pedals = [...intervals]
    .flatMap(([channel, list]) =>
      // A press and lift at one instant sustain nothing, but they are
      // still pedal actions, with their own noise.
      list.map((span) => ({ channel, ...span })),
    )
    .sort((a, b) => a.start - b.start || a.channel - b.channel);
  // Playback reaches the last pedal action that sounds, on a channel with
  // notes. A file's end is not an action.
  const channels = new Set(notes.map((n) => n.channel));
  const lastAction = pedals.reduce(
    (last, span) =>
      channels.has(span.channel)
        ? Math.max(last, span.open ? span.start : span.end)
        : last,
    -Infinity,
  );
  return {
    id,
    title,
    notes,
    tracks,
    duration: Math.max(lastAction, ...notes.map((n) => n.soundEnd)) + 0.5,
    tempos,
    ppq,
    timeSignatures: timeSignatures.sort((a, b) => a.tick - b.tick),
    pedals,
    warnings: [...new Set(warnings)],
  };
}
export const noteName = (n: number) =>
  ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][n % 12] +
  (Math.floor(n / 12) - 1);
