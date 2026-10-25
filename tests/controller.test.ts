import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Studio } from "../src/controller";
import { Metronome } from "../src/metronome";
import type { Mode } from "../src/engine";
import type { Note, Song } from "../src/song";
import { fixtureLibrary } from "./fixtures/library";

const env = vi.hoisted(() => ({
  now: 100,
  values: new Map<string, unknown>(),
  resets: [] as (() => void)[],
  /** Each studio's report that its MIDI output was lost. */
  outputLosses: [] as (() => void)[],
  /** Each studio's report that the app chose a MIDI output itself. */
  outputChoices: [] as ((id: string, opened: Promise<void>) => void)[],
  unlockWait: null as Promise<void> | null,
  prepareWait: null as Promise<void> | null,
  /** What each studio does when another tab changes stored practice. */
  watchers: new Set<() => void>(),
}));

vi.mock("../src/audio", () => ({
  PianoAudio: class {
    origin: number | null = null;
    now = () => (this.origin === null ? env.now : env.now - this.origin);
    eventTime(timestamp: number) {
      return this.now() + timestamp / 1000 - env.now;
    }
    unlock = vi.fn(async () => {
      this.origin ??= env.now;
      if (env.unlockWait) await env.unlockWait;
    });
    prepare = vi.fn(async (_notes?: unknown, _signal?: AbortSignal) => {
      if (env.prepareWait) await env.prepareWait;
    });
    setPlaybackNotes = vi.fn();
    setSound = vi.fn();
    stop = vi.fn();
    reschedule = vi.fn();
    hold = vi.fn();
    schedule = vi.fn();
    tone = vi.fn();
  },
}));
vi.mock("../src/midi", () => ({
  MidiConnection: class {
    status = "disconnected";
    message = "No piano";
    devices = [];
    player = {
      connected: false,
      stop: vi.fn(),
      schedule: vi.fn(),
      keyDown: vi.fn(),
      keyUp: vi.fn(),
    };
    selectOutput = vi.fn(async () => {});
    selectedId = "";
    constructor(callbacks: {
      onReset(): void;
      onOutputLost(): void;
      onOutputChosen(id: string, opened: Promise<void>): void;
    }) {
      env.resets.push(callbacks.onReset);
      env.outputLosses.push(callbacks.onOutputLost);
      env.outputChoices.push(callbacks.onOutputChosen);
    }
    connect = vi.fn(async () => {});
    autoConnect = vi.fn(async () => {});
    select = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock("../src/storage", () => ({
  DAILY_GOAL_CHOICES: [5, 10, 15, 20, 30],
  LEARNER_NAME_MAX: 40,
  settings: () => ({
    mode: "wait",
    speed: 1,
    left: true,
    right: true,
    duet: false,
    tolerance: 0.22,
    names: true,
    selected: "cadence-ode-to-joy-v1",
    ambience: 0.22,
    pianoVoices: {
      release: true,
      keyNoise: true,
      pedalNoise: true,
      resonance: true,
    },
    learnerName: "",
    learnerNameChosen: false,
    dailyGoalMinutes: 5,
    ...((env.values.get("settings") as object) ?? {}),
  }),
  read: (key: string, fallback: unknown) =>
    env.values.has(key) ? structuredClone(env.values.get(key)) : fallback,
  write: (key: string, value: unknown) => {
    env.values.set(key, structuredClone(value));
    return true;
  },
  readAll: (prefix: string) =>
    [...env.values]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => structuredClone(value)),
  remove: (key: string) => env.values.delete(key),
  watchStored: (_prefix: string, onChange: () => void) => {
    env.watchers.add(onChange);
    return () => env.watchers.delete(onChange);
  },
  progress: (id: string, version: string, _beats: number) => {
    const saved = (env.values.get(`progress:${id}`) ?? {}) as {
      version?: string;
    };
    return structuredClone({
      beat: 0,
      best: 0,
      attempts: 0,
      updated: "",
      assignments: {},
      loopEnabled: true,
      loopBeats: null,
      ...saved,
      // Saved for other notes: the position and passage start over.
      ...(saved.version === version ? {} : { beat: 0, loopBeats: null }),
      version,
    });
  },
}));

function song(pitches: [number, number][], id = "controller-fixture"): Song {
  return {
    id,
    title: "Integration exercise",
    duration: 4,
    ppq: 480,
    warnings: [],
    tempos: [],
    tracks: [
      { id: 0, name: "Right hand", hand: "right", count: pitches.length },
    ],
    notes: pitches.map(([pitch, start], i) => ({
      id: `note-${i}`,
      pitch,
      start,
      end: start + 0.3,
      soundEnd: start + 0.3,
      track: 0,
      channel: 0,
      velocity: 0.7,
    })),
  };
}
/** Two student notes in C position and a teacher part an octave below them. */
function duetSong(): Song {
  const fixture = song(
    [
      [60, 1],
      [64, 2],
    ],
    "duet-fixture",
  );
  const duet = (id: number, pitch: number, start: number) => ({
    id: `duet-${id}`,
    pitch,
    start,
    end: start + 0.4,
    soundEnd: start + 0.4,
    track: 2,
    channel: 2,
    velocity: 0.5,
  });
  return {
    ...fixture,
    notes: fixture.notes.map((note) => ({
      ...note,
      finger: note.pitch === 60 ? 1 : 3,
      fingerHand: "right",
    })),
    lesson: {
      composer: "",
      description: "",
      level: "",
      bpm: 60,
      handPositions: {
        left: "C position · C3 (5) to G3 (1)",
        right: "C position · C4 (1) to G4 (5)",
      },
    },
    duet: {
      octaves: 1,
      notes: [
        duet(0, 43, 0.5),
        duet(1, 48, 1),
        duet(2, 47, 1.5),
        duet(3, 45, 2),
      ],
    },
  };
}
const active: Studio[] = [];
function create(fixture?: Song) {
  const studio = new Studio(fixtureLibrary());
  active.push(studio);
  if (fixture) studio.load(fixture);
  studio.speed(1);
  return studio;
}
function advance(studio: Studio, seconds: number) {
  env.now += seconds;
  studio.tick();
}
function midi(studio: Studio, data: number[], delay = 0) {
  studio.receive(new Uint8Array(data), (env.now - delay) * 1000);
}
/** A MIDI output is open, or with `false`, has gone. */
function output(studio: Studio, connected = true) {
  Object.defineProperty(studio.midi.player, "connected", {
    value: connected,
    configurable: true,
  });
}

beforeEach(() => {
  env.now = 100;
  env.values.clear();
  env.watchers.clear();
  env.resets = [];
  env.outputLosses = [];
  env.outputChoices = [];
  env.unlockWait = null;
  env.prepareWait = null;
  vi.spyOn(performance, "now").mockImplementation(() => env.now * 1000);
});
afterEach(() => {
  for (const studio of active.splice(0)) studio.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("practice studio integration", () => {
  it("restarts a passage still loading without a voice turned off", async () => {
    const studio = create(
      song([
        [60, 0],
        [64, 2],
      ]),
    );
    studio.mode("listen");
    let finish!: () => void;
    env.prepareWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const playing = studio.play();
    await vi.waitFor(() => expect(studio.audio.prepare).toHaveBeenCalledOnce());
    const [, signal] = vi.mocked(studio.audio.prepare).mock.calls[0];
    studio.pianoVoice("resonance", false);
    // The loading voice's recordings are no longer waited for.
    expect(signal!.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(studio.audio.prepare).toHaveBeenCalledTimes(2),
    );
    finish();
    await playing;
    await vi.waitFor(() => expect(studio.transport.playing).toBe(true));
    expect(studio.position).toBe(0);
  });

  it("restores sound preferences before audio starts and preserves them across songs", () => {
    env.values.set("settings", { ambience: 0.43 });
    const studio = create();
    expect(studio.audio.setSound).toHaveBeenCalledWith({
      ambience: 0.43,
      voices: studio.settings.pianoVoices,
    });
    studio.sound(0.31);
    studio.load(fixtureLibrary()[1]);
    expect(studio.settings).toMatchObject({
      ambience: 0.31,
    });
    const restored = create();
    expect(restored.audio.setSound).toHaveBeenCalledWith({
      ambience: 0.31,
      voices: restored.settings.pianoVoices,
    });
  });

  it("turns optional piano voices off live, and replays from here to load one turned on", async () => {
    const studio = create(
      song([
        [60, 0],
        [64, 2],
      ]),
    );
    studio.mode("listen");
    await studio.play();
    advance(studio, 0.2);
    const position = studio.position;
    vi.mocked(studio.audio.prepare).mockClear();
    studio.pianoVoice("resonance", false);
    const off = {
      release: true,
      keyNoise: true,
      pedalNoise: true,
      resonance: false,
    };
    expect(studio.audio.setSound).toHaveBeenLastCalledWith({ voices: off });
    expect(env.values.get("settings")).toMatchObject({ pianoVoices: off });
    expect(studio.transport.playing).toBe(true);
    expect(studio.audio.prepare).not.toHaveBeenCalled();
    studio.pianoVoice("resonance", true);
    expect(studio.transport.playing).toBe(false);
    await vi.waitFor(() => expect(studio.transport.playing).toBe(true));
    expect(studio.audio.prepare).toHaveBeenCalledOnce();
    expect(studio.position).toBeCloseTo(position);
    expect(studio.settings.pianoVoices.resonance).toBe(true);
  });

  it("changes sound live without interrupting playback or resetting practice", async () => {
    const studio = create(
      song([
        [60, 0],
        [64, 2],
      ]),
    );
    studio.mode("listen");
    await studio.play();
    advance(studio, 0.2);
    const position = studio.position;
    const epoch = studio.scoringEpoch;
    const practice = studio.practice;
    vi.mocked(studio.audio.stop).mockClear();
    vi.mocked(studio.audio.prepare).mockClear();
    studio.sound(0.6);
    expect(studio.audio.setSound).toHaveBeenLastCalledWith({
      ambience: 0.6,
    });
    expect(studio.audio.stop).not.toHaveBeenCalled();
    expect(studio.audio.prepare).not.toHaveBeenCalled();
    expect(studio.transport.playing).toBe(true);
    expect(studio.position).toBe(position);
    expect(studio.scoringEpoch).toBe(epoch);
    expect(studio.practice).toBe(practice);
  });

  it("keeps a pending playback preparation alive when sound changes", async () => {
    const studio = create(
      song([
        [60, 0],
        [64, 2],
      ]),
    );
    studio.mode("listen");
    let finish!: () => void;
    env.prepareWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const playing = studio.play();
    await vi.waitFor(() => expect(studio.audio.prepare).toHaveBeenCalledOnce());
    const signal = vi.mocked(studio.audio.prepare).mock.calls[0][1]!;
    studio.sound(0);
    expect(signal.aborted).toBe(false);
    finish();
    await playing;
    expect(studio.transport.playing).toBe(true);
  });

  it("initializes once and recreates MIDI after the studio is restarted", async () => {
    const studio = create();
    const originalMidi = studio.midi;
    studio.init();
    const timer = studio.timer;
    studio.init();
    expect(originalMidi.autoConnect).toHaveBeenCalledOnce();
    expect(studio.timer).toBe(timer);
    studio.destroy();
    expect(studio.timer).toBeNull();
    expect(originalMidi.dispose).toHaveBeenCalledOnce();
    studio.init();
    expect(studio.midi).not.toBe(originalMidi);
    expect(studio.midi.autoConnect).toHaveBeenCalledOnce();
    await studio.midi.connect();
    expect(studio.midi.connect).toHaveBeenCalledOnce();
    expect(studio.timer).not.toBeNull();
  });

  it("loads the studio while automatic MIDI connection is still pending", async () => {
    const studio = create();
    vi.mocked(studio.midi.autoConnect).mockReturnValue(
      new Promise<void>(() => {}),
    );
    studio.init();
    expect(studio.timer).not.toBeNull();
    expect(studio.songs.length).toBeGreaterThan(0);
    expect(studio.midi.autoConnect).toHaveBeenCalledOnce();
  });

  it.each(["song", "mode", "seek", "pause"] as const)(
    "cancels pending sample preparation when %s changes",
    async (change) => {
      const studio = create(song([[60, 1]]));
      studio.mode("listen");
      let finish!: () => void;
      env.prepareWait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const starting = studio.play();
      await vi.waitFor(() =>
        expect(studio.audio.prepare).toHaveBeenCalledOnce(),
      );
      if (change === "song") studio.load(song([[62, 1]], "replacement"));
      else if (change === "mode") studio.mode("rhythm");
      else if (change === "seek") studio.seek(2);
      else studio.pause();
      expect(vi.mocked(studio.audio.prepare).mock.calls[0][1]?.aborted).toBe(
        true,
      );
      finish();
      await starting;
      expect(studio.transport.playing).toBe(false);
      expect(studio.progress.attempts).toBe(0);
    },
  );

  it.each([
    ["listen", false, true],
    ["wait", false, false],
    ["rhythm", false, false],
    ["rhythm", true, true],
  ] as const)(
    "after losing the MIDI output in %s (duet: %s), stops only a run that sent it notes: %s",
    async (mode, duet, stops) => {
      const studio = create(duetSong());
      if (duet) studio.duet();
      studio.mode(mode);
      output(studio);
      await studio.play();
      output(studio, false);
      env.outputLosses.at(-1)!();
      expect(studio.transport.playing).toBe(!stops);
      expect(studio.notice).toBe(
        stops ? "Piano output disconnected. Press Play to continue." : "",
      );
    },
  );

  it("keeps the original resume intent by serializing output choices", async () => {
    const studio = create(duetSong());
    studio.mode("listen");
    await studio.play();
    let finish!: () => void;
    vi.mocked(studio.midi.selectOutput).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    output(studio);
    const selecting = studio.soundOutput("first");
    expect(studio.outputChanging).toBe(true);
    expect(studio.transport.playing).toBe(false);
    await studio.play();
    expect(studio.transport.playing).toBe(false);
    await studio.soundOutput("second");
    expect(studio.midi.selectOutput).toHaveBeenCalledExactlyOnceWith("first");
    finish();
    await selecting;
    expect(studio.transport.playing).toBe(true);
    expect(studio.outputChanging).toBe(false);
  });

  it("moves a run to the piano output the app chooses as it connects", async () => {
    const studio = create(duetSong());
    studio.mode("listen");
    await studio.play();
    advance(studio, 0.5);
    let finish!: () => void;
    const opened = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(studio.audio.prepare).mockClear();
    env.outputChoices.at(-1)!("piano", opened);
    // Nothing plays, or starts, until the piano is open.
    expect(studio.outputChanging).toBe(true);
    expect(studio.transport.playing).toBe(false);
    await studio.play();
    expect(studio.transport.playing).toBe(false);
    output(studio);
    finish();
    await vi.waitFor(() => expect(studio.transport.playing).toBe(true));
    expect(studio.outputChanging).toBe(false);
    expect(studio.position).toBeCloseTo(0.5);
    // The piano plays it all, so the laptop loads nothing.
    expect(studio.audio.prepare).not.toHaveBeenCalled();
    expect(studio.audio.setPlaybackNotes).toHaveBeenLastCalledWith([], []);
  });

  it("stays paused when the piano output the app chose fails to open", async () => {
    const studio = create(duetSong());
    studio.mode("listen");
    await studio.play();
    const choosing = Promise.resolve();
    env.outputChoices.at(-1)!("piano", choosing);
    await choosing;
    await vi.waitFor(() => expect(studio.outputChanging).toBe(false));
    await Promise.resolve();
    expect(studio.transport.playing).toBe(false);
    await studio.play();
    expect(studio.transport.playing).toBe(true);
  });

  it("counts an on-screen key while the output opens, but sounds it nowhere", async () => {
    const studio = create(song([[60, 1]]));
    let finish!: () => void;
    vi.mocked(studio.midi.selectOutput).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const selecting = studio.soundOutput("piano");
    studio.virtual(60, true);
    expect(studio.input.down.has(60)).toBe(true);
    expect(studio.midi.player.keyDown).not.toHaveBeenCalled();
    // Laptop sound would start by unlocking browser audio straight away.
    expect(studio.audio.unlock).not.toHaveBeenCalled();
    studio.virtual(60, false);
    finish();
    await selecting;
  });

  it("starts no run while an output choice is still opening", async () => {
    const studio = create(duetSong());
    studio.mode("listen");
    let finish!: () => void;
    vi.mocked(studio.midi.selectOutput).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const selecting = studio.soundOutput("piano");
    // A run started now would prepare its notes for the laptop.
    await studio.play();
    expect(studio.transport.playing).toBe(false);
    expect(studio.audio.prepare).not.toHaveBeenCalled();
    finish();
    await selecting;
    // It was not playing before the choice, so the choice does not start it.
    expect(studio.transport.playing).toBe(false);
    await studio.play();
    expect(studio.transport.playing).toBe(true);
  });

  it("does not duplicate a virtual note released and re-pressed during sample loading", async () => {
    const studio = create(song([[60, 1]]));
    let finish!: () => void;
    env.prepareWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    studio.virtual(60, true);
    studio.virtual(60, false);
    studio.virtual(60, true);
    await vi.waitFor(() =>
      expect(studio.audio.prepare).toHaveBeenCalledTimes(2),
    );
    finish();
    await vi.waitFor(() => expect(studio.audio.tone).toHaveBeenCalledOnce());
  });

  it("plays on-screen keys on the MIDI output while they are held, and never echoes the piano's own", async () => {
    const studio = create(song([[60, 1]]));
    output(studio);
    midi(studio, [0x90, 64, 100]);
    midi(studio, [0x80, 64, 0]);
    expect(studio.midi.player.keyDown).not.toHaveBeenCalled();
    studio.virtual(60, true);
    expect(studio.midi.player.keyDown).toHaveBeenCalledExactlyOnceWith(60, 0.6);
    expect(studio.input.down.has(60)).toBe(true);
    studio.virtual(60, false);
    expect(studio.midi.player.keyUp).toHaveBeenCalledExactlyOnceWith(60);
    // A computer shortcut held as the window loses focus comes up too.
    studio.virtual(62, true);
    studio.releaseKeys();
    expect(studio.midi.player.keyUp).toHaveBeenLastCalledWith(62);
    expect(studio.input.down.size).toBe(0);
    await Promise.resolve();
    expect(studio.audio.unlock).not.toHaveBeenCalled();
    expect(studio.audio.tone).not.toHaveBeenCalled();
  });

  it.each(["listen", "rhythm"] as const)(
    "handles a bound MIDI source reset while %s samples are preparing",
    async (mode) => {
      // Rhythm plays only the duet, which needs its samples.
      const studio = create(duetSong());
      studio.duet();
      studio.mode(mode);
      let finish!: () => void;
      env.prepareWait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const starting = studio.play();
      await vi.waitFor(() =>
        expect(studio.audio.prepare).toHaveBeenCalledOnce(),
      );
      const signal = vi.mocked(studio.audio.prepare).mock.calls[0][1]!;
      studio.input.message(new Uint8Array([0x90, 60, 100]));
      env.resets.at(-1)!();
      expect(studio.input.down.size).toBe(0);
      expect(signal.aborted).toBe(mode === "rhythm");
      if (mode === "rhythm")
        expect(studio.notice).toMatch(/Piano connection changed.*Press Play/);
      finish();
      await starting;
      expect(studio.transport.playing).toBe(mode === "listen");
      expect(studio.progress.attempts).toBe(mode === "listen" ? 1 : 0);
    },
  );

  it("keeps concurrent playback and virtual-key preparations until the session changes", async () => {
    const studio = create(song([[60, 1]]));
    studio.mode("listen");
    let finish!: () => void;
    env.prepareWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const starting = studio.play();
    await vi.waitFor(() => expect(studio.audio.prepare).toHaveBeenCalledOnce());
    studio.virtual(63, true);
    await vi.waitFor(() =>
      expect(studio.audio.prepare).toHaveBeenCalledTimes(2),
    );
    const signals = vi
      .mocked(studio.audio.prepare)
      .mock.calls.map((call) => call[1]!);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    studio.pause();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    finish();
    await starting;
    expect(studio.transport.playing).toBe(false);
  });

  it.each(["play", "virtual"] as const)(
    "reports sample preparation failure during %s without starting sound",
    async (action) => {
      const studio = create(song([[60, 1]]));
      if (action === "play") studio.mode("listen");
      vi.mocked(studio.audio.prepare).mockRejectedValueOnce(
        new Error("Unable to load sample"),
      );
      if (action === "virtual") studio.virtual(60, true);
      else await studio.play();
      await vi.waitFor(() => expect(studio.notice).toMatch(/try.*again/i));
      expect(studio.audio.tone).not.toHaveBeenCalled();
      expect(studio.transport.playing).toBe(false);
      expect(studio.progress.attempts).toBe(0);
    },
  );

  it.each([1, 1.4])(
    "lets the final piano release finish naturally at %sx speed, while explicit pause still stops it",
    async (speed) => {
      const studio = create(song([[60, 3.5]]));
      studio.loop(false);
      studio.mode("listen");
      studio.speed(speed);
      await studio.play();
      vi.mocked(studio.audio.stop).mockClear();
      advance(studio, 4 / speed + 0.001);
      expect(studio.transport.playing).toBe(false);
      expect(studio.notice).toBe("");
      expect(studio.audio.stop).not.toHaveBeenCalled();
      studio.pause();
      expect(studio.audio.stop).toHaveBeenCalledOnce();
    },
  );

  it("moves only waiting notes to a new speed during playback", async () => {
    const studio = create(
      song([
        [60, 0],
        [64, 2],
      ]),
    );
    studio.mode("listen");
    await studio.play();
    advance(studio, 0.2);
    vi.mocked(studio.audio.stop).mockClear();
    studio.speed(0.5);
    expect(studio.audio.reschedule).toHaveBeenCalledOnce();
    expect(studio.audio.stop).not.toHaveBeenCalled();
    expect(studio.transport.playing).toBe(true);
    studio.pause();
    vi.mocked(studio.audio.stop).mockClear();
    studio.speed(1);
    expect(studio.audio.stop).toHaveBeenCalledExactlyOnceWith();
    expect(studio.audio.reschedule).toHaveBeenCalledOnce();
  });

  it("keeps sounding notes when loop bounds change while the loop is off", async () => {
    const studio = create(
      song([
        [60, 0.5],
        [63, 1.5],
      ]),
    );
    studio.mode("listen");
    studio.loop(false);
    await studio.play();
    advance(studio, 0.6);
    vi.mocked(studio.audio.stop).mockClear();
    studio.bounds(0, 3);
    expect(studio.transport.playing).toBe(true);
    expect(studio.audio.stop).not.toHaveBeenCalled();
    expect(studio.transport.loop).toBeNull();
  });

  it.each(["speed", "seek", "loop wrap"] as const)(
    "retains prepared passage recordings through %s during playback",
    async (change) => {
      const studio = create(
        song([
          [60, 0.5],
          [63, 1.5],
        ]),
      );
      studio.mode("listen");
      if (change === "loop wrap") {
        studio.bounds(0, 2);
        studio.loop(true);
      }
      await studio.play();
      vi.mocked(studio.audio.stop).mockClear();
      if (change === "speed") studio.speed(0.75);
      else if (change === "seek") studio.seek(1);
      else advance(studio, 2.1);
      expect(studio.transport.playing).toBe(true);
      if (change === "seek")
        expect(studio.audio.stop).toHaveBeenCalledWith(false);
      expect(
        vi
          .mocked(studio.audio.stop)
          .mock.calls.every(([release]) => release === false),
      ).toBe(true);
      expect(studio.audio.setPlaybackNotes).not.toHaveBeenCalledWith([]);
    },
  );

  it.each(["disable", "expand", "enable"] as const)(
    "loads the new passage scope before resuming when loop is changed: %s",
    async (change) => {
      const studio = create(
        song([
          [60, 0.5],
          [63, 2.5],
        ]),
      );
      studio.mode("listen");
      studio.bounds(0, 1.5);
      if (change === "enable") studio.loop(false);
      await studio.play();
      advance(studio, 0.25);
      vi.mocked(studio.audio.prepare).mockClear();
      vi.mocked(studio.audio.setPlaybackNotes).mockClear();
      let finish!: () => void;
      env.prepareWait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (change === "disable") studio.loop(false);
      else if (change === "expand") studio.bounds(0, 3);
      else studio.loop(true);
      expect(studio.transport.playing).toBe(false);
      const position = change === "disable" ? 0.25 : 0;
      expect(studio.position).toBeCloseTo(position);
      await vi.waitFor(() =>
        expect(studio.audio.prepare).toHaveBeenCalledOnce(),
      );
      const prepared = change === "enable" ? [studio.notes[0]] : studio.notes;
      expect(studio.audio.prepare).toHaveBeenCalledWith(
        prepared,
        expect.any(AbortSignal),
        [],
      );
      advance(studio, 1);
      expect(studio.position).toBeCloseTo(position);
      expect(studio.audio.setPlaybackNotes).not.toHaveBeenCalled();
      finish();
      await vi.waitFor(() => expect(studio.transport.playing).toBe(true));
      expect(studio.audio.setPlaybackNotes).toHaveBeenCalledWith(prepared, []);
      expect(studio.position).toBeCloseTo(position);
    },
  );

  it("resumes the latest loop range after repeated edits while samples load", async () => {
    const studio = create(
      song([
        [60, 0.5],
        [63, 2.5],
      ]),
    );
    studio.mode("listen");
    studio.bounds(0, 1.5);
    studio.loop(true);
    await studio.play();
    vi.mocked(studio.audio.prepare).mockClear();
    vi.mocked(studio.audio.setPlaybackNotes).mockClear();
    let finishFirst!: () => void, finishLatest!: () => void;
    env.prepareWait = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    studio.bounds(0, 2);
    await vi.waitFor(() =>
      expect(studio.audio.prepare).toHaveBeenCalledTimes(1),
    );
    const firstPreparation = vi.mocked(studio.audio.prepare).mock.results[0]
      .value;
    env.prepareWait = new Promise<void>((resolve) => {
      finishLatest = resolve;
    });
    studio.bounds(0, 3);
    await vi.waitFor(() =>
      expect(studio.audio.prepare).toHaveBeenCalledTimes(2),
    );
    finishFirst();
    await firstPreparation;
    await Promise.resolve();
    expect(studio.transport.playing).toBe(false);
    expect(studio.audio.setPlaybackNotes).not.toHaveBeenCalled();
    finishLatest();
    await vi.waitFor(() => expect(studio.transport.playing).toBe(true));
    expect(studio.transport.loop).toEqual([0, 3]);
    expect(studio.audio.setPlaybackNotes).toHaveBeenCalledExactlyOnceWith(
      studio.notes,
      [],
    );
  });

  it.each(["pause", "seek", "mode", "song"] as const)(
    "cancels loop-resume intent after an explicit %s during preparation",
    async (change) => {
      const studio = create(
        song([
          [60, 0.5],
          [63, 2.5],
        ]),
      );
      studio.mode("listen");
      studio.bounds(0, 1.5);
      studio.loop(true);
      await studio.play();
      vi.mocked(studio.audio.prepare).mockClear();
      let finish!: () => void;
      env.prepareWait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      studio.bounds(0, 3);
      await vi.waitFor(() =>
        expect(studio.audio.prepare).toHaveBeenCalledOnce(),
      );
      const preparation = vi.mocked(studio.audio.prepare).mock.results[0].value;
      if (change === "pause") studio.pause();
      else if (change === "seek") studio.seek(1);
      else if (change === "mode") studio.mode("wait");
      else studio.load(song([[65, 0.5]], "replacement"));
      studio.bounds(0, 2.8);
      finish();
      await preparation;
      await Promise.resolve();
      expect(studio.transport.playing).toBe(false);
      expect(studio.audio.prepare).toHaveBeenCalledOnce();
    },
  );

  it("prepares sustained notes overlapping a loop boundary without adding scoring targets", async () => {
    const fixture = song([
      [60, 0.5],
      [63, 2.5],
    ]);
    fixture.notes[0].soundEnd = 1.5;
    const studio = create(fixture);
    studio.mode("listen");
    studio.bounds(1, 3);
    studio.loop(true);
    expect(studio.scoringNotes).toEqual([studio.notes[1]]);
    await studio.play();
    expect(studio.audio.prepare).toHaveBeenCalledExactlyOnceWith(
      studio.notes,
      expect.any(AbortSignal),
      [],
    );
    expect(studio.audio.setPlaybackNotes).toHaveBeenCalledWith(
      studio.notes,
      [],
    );
    expect(studio.position).toBe(1);
  });

  it.each(["wait", "rhythm"] as const)(
    "starts %s practice without loading or pinning the sample bank",
    async (mode) => {
      // An older save's Rhythm reference sound no longer plays the part.
      env.values.set("settings", { reference: true });
      const studio = create(
        song([
          [60, 0.5],
          [63, 2.5],
        ]),
      );
      studio.mode(mode);
      vi.mocked(studio.audio.prepare).mockRejectedValue(
        new Error("sample bank unavailable"),
      );
      await studio.play();
      expect(studio.audio.prepare).not.toHaveBeenCalled();
      expect(studio.audio.setPlaybackNotes).toHaveBeenCalledWith([], []);
      expect(studio.transport.playing).toBe(true);
      advance(studio, 0.5);
      midi(studio, [0x90, 60, 100]);
      expect(studio.practice.hit.has("note-0")).toBe(true);
    },
  );

  it("starts on the saved song, or the first one once it leaves the library", () => {
    const songs = fixtureLibrary();
    env.values.set("settings", { selected: songs[1].id });
    expect(create().song.id).toBe(songs[1].id);
    env.values.set("settings", { selected: "gone-from-library" });
    expect(create().song.id).toBe(songs[0].id);
  });

  it("turns each hand on and off on its own, including both off", async () => {
    const studio = create(
      song([
        [60, 1],
        [64, 2],
      ]),
    );
    studio.hand("right");
    studio.hand("left");
    expect(studio.settings).toMatchObject({ left: false, right: false });
    expect(studio.notes).toHaveLength(0);
    await studio.play();
    expect(studio.transport.playing).toBe(false);
    expect(studio.notice).toMatch(/Turn on Left, Right, or both hands/);
    studio.hand("right");
    expect(studio.settings).toMatchObject({ left: false, right: true });
    expect(studio.notes).toHaveLength(2);
  });

  it.each([false, true])(
    "accepts Wait input within the early tolerance even when delivered after the gate (already held: %s)",
    async (held) => {
      const studio = create(song([[60, 1]]));
      studio.tolerance(0.5);
      await studio.play();
      env.now += 1.1;
      if (held) studio.tick();
      midi(studio, [0x90, 60, 100], 0.3);
      expect(studio.position).toBe(1);
      expect(studio.practice.hit).toEqual(new Set(["note-0"]));
      expect(studio.practice.gate).toBeUndefined();
    },
  );

  it.each([0.6, 1, 1.4])(
    "accepts a Wait note 500ms early at %sx without jumping the timeline forward",
    async (speed) => {
      const studio = create(
        song([
          [60, 1],
          [62, 2],
        ]),
      );
      studio.speed(speed);
      studio.tolerance(0.5);
      await studio.play();
      advance(studio, 1 / speed - 0.5);
      midi(studio, [0x90, 60, 100]);
      expect(studio.practice.hit).toEqual(new Set(["note-0"]));
      expect(studio.practice.gate?.start).toBe(2);
      expect(studio.position).toBeCloseTo(1 - 0.5 * speed);
      advance(studio, 0.1);
      expect(studio.position).toBeCloseTo(1 - 0.4 * speed);
    },
  );

  it("keeps early chord input until every freshly played chord pitch is held", async () => {
    const studio = create(
      song([
        [60, 1],
        [64, 1],
        [62, 2],
      ]),
    );
    studio.tolerance(0.5);
    await studio.play();
    advance(studio, 0.6);
    midi(studio, [0x90, 60, 100]);
    expect(studio.practice.gate?.start).toBe(1);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    advance(studio, 0.1);
    midi(studio, [0x90, 64, 100]);
    expect(studio.practice.hit).toEqual(new Set(["note-0", "note-1"]));
    expect(studio.practice.gate?.start).toBe(2);
    expect(studio.position).toBeCloseTo(0.7);
  });

  it.each([false, true])(
    "accepts Wait input played after the gate despite delayed delivery (already held: %s)",
    async (held) => {
      const studio = create(song([[60, 1]]));
      await studio.play();
      if (held) advance(studio, 1);
      env.now = 102;
      midi(studio, [0x90, 60, 100], 0.5);
      expect(studio.practice.hit).toEqual(new Set(["note-0"]));
      expect(studio.practice.gate).toBeUndefined();
    },
  );

  it("reanchors the transport when browser audio starts with a different clock origin", async () => {
    const studio = create(song([[60, 1]]));
    studio.mode("listen");
    await studio.play();
    advance(studio, 2);
    expect(studio.position).toBe(2);
    studio.pause();
    advance(studio, 100);
    expect(studio.position).toBe(2);
    await studio.play();
    advance(studio, 0.5);
    expect(studio.position).toBe(2.5);
  });

  it("allows Listen and virtual Wait practice without requesting MIDI permission", async () => {
    const studio = create(song([[60, 1]]));
    await studio.play();
    advance(studio, 5);
    expect(studio.position).toBe(1);
    studio.virtual(60, true);
    expect(studio.practice.gate).toBeUndefined();
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.midi.connect).not.toHaveBeenCalled();
    studio.virtual(60, false);
    studio.mode("listen");
    studio.seek(0);
    await studio.play();
    advance(studio, 2);
    expect(studio.position).toBe(2);
    expect(studio.midi.connect).not.toHaveBeenCalled();
  });

  it("requires a physical re-press for repeated notes while keeping pedal sound distinct", async () => {
    const studio = create(
      song([
        [60, 1],
        [60, 2],
      ]),
    );
    await studio.play();
    advance(studio, 1);
    midi(studio, [0x90, 60, 100]);
    expect(studio.practice.gate?.start).toBe(2);
    advance(studio, 10);
    expect(studio.position).toBe(2);
    midi(studio, [0x90, 60, 100]);
    expect(studio.practice.gate?.start).toBe(2);
    midi(studio, [0xb0, 64, 127]);
    midi(studio, [0x90, 60, 0]);
    expect(studio.input.down.size).toBe(0);
    expect(studio.input.sounding.has(60)).toBe(true);
    midi(studio, [0x90, 60, 80]);
    expect(studio.practice.gate).toBeUndefined();
    expect(studio.practice.hit.size).toBe(2);
    expect(studio.lastVelocity).toBe(80);
  });

  it("uses the MIDI event timestamp to correct an apparent late-delivery miss", async () => {
    const studio = create(song([[60, 1]]));
    studio.mode("rhythm");
    studio.tolerance(0.12);
    await studio.play();
    advance(studio, 1.3);
    expect(studio.practice.missed).toEqual(new Set(["note-0"]));
    midi(studio, [0x90, 60, 100], 0.3);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.practice.missed.size).toBe(0);
    expect(studio.practice.feedback.at(-1)?.offset).toBeCloseTo(0);
  });

  it("clears keys and sustain and pauses practice on disconnect, then accepts a fresh chord", async () => {
    const studio = create(
      song([
        [60, 1],
        [64, 1],
      ]),
    );
    await studio.play();
    advance(studio, 1);
    midi(studio, [0x90, 60, 100]);
    midi(studio, [0xb0, 64, 127]);
    midi(studio, [0x80, 60, 0]);
    env.resets.at(-1)!();
    expect(studio.transport.playing).toBe(false);
    expect(studio.input.down.size).toBe(0);
    expect(studio.input.sounding.size).toBe(0);
    expect(studio.input.sustain).toBe(false);
    expect(studio.notice).toMatch(/connection changed/i);
    await studio.play();
    midi(studio, [0x90, 60, 100]);
    midi(studio, [0x90, 64, 100]);
    expect(studio.practice.gate).toBeUndefined();
  });

  it("keeps Listen running through a MIDI disconnect", async () => {
    const studio = create(song([[60, 1]]));
    studio.mode("listen");
    await studio.play();
    advance(studio, 0.5);
    env.resets.at(-1)!();
    expect(studio.transport.playing).toBe(true);
    advance(studio, 0.5);
    expect(studio.position).toBe(1);
  });

  it("clears partial chord hits, physical keys and pedal state on restart", async () => {
    const studio = create(
      song([
        [60, 1],
        [64, 1],
      ]),
    );
    await studio.play();
    advance(studio, 1);
    midi(studio, [0x90, 60, 100]);
    midi(studio, [0xb0, 64, 127]);
    studio.seek(0);
    expect(studio.input.down.size).toBe(0);
    expect(studio.input.sounding.size).toBe(0);
    expect(studio.input.sustain).toBe(false);
    expect(studio.practice.hit.size).toBe(0);
    expect(studio.practice.gate?.start).toBe(1);
  });

  it("matches delayed MIDI using the speed active at its timestamp", async () => {
    const studio = create(song([[60, 0.9]]));
    studio.mode("rhythm");
    studio.tolerance(0.12);
    await studio.play();
    advance(studio, 1);
    studio.speed(0.5);
    env.now += 0.1;
    midi(studio, [0x90, 60, 100], 0.2);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.practice.feedback.at(-1)?.offset).toBeCloseTo(0);
  });

  it("rejects queued note-on scoring from before a seek", async () => {
    const studio = create(
      song([
        [60, 1],
        [62, 2],
      ]),
    );
    studio.mode("rhythm");
    await studio.play();
    advance(studio, 1);
    studio.seek(2);
    midi(studio, [0x90, 62, 100], 0.2);
    expect(studio.practice.hit.size).toBe(0);
    expect(studio.practice.feedback).toEqual([]);
    midi(studio, [0x80, 62, 0]);
    midi(studio, [0x90, 62, 100]);
    expect(studio.practice.hit).toEqual(new Set(["note-1"]));
  });

  it("scores current-loop MIDI when an input callback is the first update after crossing the loop end", async () => {
    const studio = create(
      song([
        [60, 0.2],
        [62, 1.2],
      ]),
    );
    studio.mode("rhythm");
    studio.bounds(0, 2);
    studio.loop(true);
    await studio.play();
    advance(studio, 0.2);
    midi(studio, [0x90, 60, 100]);
    midi(studio, [0x80, 60, 0]);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    advance(studio, 1.7);
    env.now += 0.3; // The next callback is MIDI, before the interval has observed the wrap.
    midi(studio, [0x90, 60, 100]);
    expect(studio.position).toBeCloseTo(0.2);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
  });

  it("resets the loop pass when Pause is the first update after crossing its end", async () => {
    const studio = create(
      song([
        [60, 0.5],
        [62, 1.5],
      ]),
    );
    studio.mode("rhythm");
    studio.bounds(0, 2);
    studio.loop(true);
    await studio.play();
    advance(studio, 0.5);
    midi(studio, [0x90, 60, 100]);
    midi(studio, [0x80, 60, 0]);
    advance(studio, 1.3);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.practice.missed).toEqual(new Set(["note-1"]));
    env.now += 0.3; // Pause arrives at 2.1 before any interval update observes the new pass.
    studio.pause();
    expect(studio.position).toBeCloseTo(0.1);
    expect(studio.transport.playing).toBe(false);
    expect(studio.practice.hit.size).toBe(0);
    expect(studio.practice.missed.size).toBe(0);
    await studio.play();
    env.now += 0.4;
    midi(studio, [0x90, 60, 100]);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.practice.missed.size).toBe(0);
  });

  it.each([
    ["before", 0],
    ["after", 0.1],
  ] as const)(
    "credits a Rhythm press just before a loop wrap, delivered %s it, to the next pass",
    async (_, delay) => {
      const studio = create(
        song([
          [60, 0],
          [62, 1],
        ]),
      );
      studio.mode("rhythm");
      studio.bounds(0, 2);
      studio.loop(true);
      await studio.play();
      midi(studio, [0x90, 60, 100]);
      midi(studio, [0x80, 60, 0]);
      advance(studio, 1);
      midi(studio, [0x90, 62, 100]);
      midi(studio, [0x80, 62, 0]);
      advance(studio, 0.95);
      env.now += delay;
      midi(studio, [0x90, 60, 100], delay); // 50 ms early for the next pass.
      midi(studio, [0x80, 60, 0]);
      expect(studio.practice.stats.wrong).toBe(0);
      advance(studio, 0.3);
      expect(studio.position).toBeCloseTo(0.25 + delay);
      expect(studio.practice.hit).toEqual(new Set(["note-0"]));
      expect(studio.practice.missed.size).toBe(0);
      expect(studio.practice.feedback).toMatchObject([
        { pitch: 60, offset: expect.closeTo(-0.05) },
      ]);
    },
  );

  it("scores a Rhythm press just after a loop wrap late for the previous pass's last note", async () => {
    const studio = create(
      song([
        [62, 0.2],
        [62, 1.95],
      ]),
    );
    studio.mode("rhythm");
    studio.bounds(0, 2);
    studio.loop(true);
    await studio.play();
    advance(studio, 0.2);
    midi(studio, [0x90, 62, 100]);
    midi(studio, [0x80, 62, 0]);
    advance(studio, 1.7);
    advance(studio, 0.12);
    expect(studio.position).toBeCloseTo(0.02);
    midi(studio, [0x90, 62, 100]); // 70 ms late for the note at 1.95.
    midi(studio, [0x80, 62, 0]);
    expect(studio.practice.feedback).toMatchObject([
      { kind: "late", pitch: 62, offset: expect.closeTo(0.07) },
    ]);
    // The new pass's first note, of the same pitch, is still to be played.
    expect(studio.practice.hit.size).toBe(0);
    advance(studio, 0.18);
    midi(studio, [0x90, 62, 100]);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.practice.missed.size).toBe(0);
    expect(studio.practice.stats.wrong).toBe(0);
  });

  it("rejects a Wait note outside the early tolerance, but accepts an exact-gate timestamp", async () => {
    const studio = create(song([[60, 1]]));
    studio.tolerance(0.5);
    await studio.play();
    advance(studio, 1.2);
    expect(studio.position).toBe(1);
    midi(studio, [0x90, 60, 100], 0.8); // Pressed at .4, outside the 500ms early window.
    expect(studio.practice.hit.size).toBe(0);
    expect(studio.practice.gate?.start).toBe(1);
    midi(studio, [0x80, 60, 0]);
    midi(studio, [0x90, 60, 100], 0.2); // Pressed at exactly 1, delivered at 1.2.
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.practice.gate).toBeUndefined();
  });

  it("accepts delayed Wait input during a gate hold after a late loop-wrap update", async () => {
    const studio = create(song([[60, 0.25]]));
    studio.bounds(0, 2);
    studio.loop(true);
    await studio.play();
    advance(studio, 0.25);
    midi(studio, [0x90, 60, 100]);
    midi(studio, [0x80, 60, 0]);
    expect(studio.practice.gate).toBeUndefined();
    advance(studio, 1.55);
    env.now += 1.1; // The clock reaches 2.9 before the interval observes the wrap at 2.
    studio.tick();
    expect(studio.position).toBe(0.25);
    expect(studio.practice.gate?.start).toBe(0.25);
    expect(studio.practice.hit.size).toBe(0);
    // This press occurred at 2.5, after the new pass should have reached and held its .25 gate.
    midi(studio, [0x90, 60, 100], 0.4);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.practice.gate).toBeUndefined();
  });

  it.each(["song", "mode", "seek", "pause"] as const)(
    "cancels pending audio startup when %s changes before unlock resolves",
    async (change) => {
      const studio = create(song([[60, 1]]));
      let finishUnlock!: () => void;
      env.unlockWait = new Promise<void>((resolve) => {
        finishUnlock = resolve;
      });
      const starting = studio.play();
      expect(studio.audio.unlock).toHaveBeenCalledOnce();
      expect(studio.transport.playing).toBe(false);
      if (change === "song") studio.load(song([[62, 1]], "replacement"));
      else if (change === "mode") studio.mode("rhythm");
      else if (change === "seek") studio.seek(2);
      else studio.pause();
      const expected = {
        song: studio.song.id,
        mode: studio.settings.mode,
        position: studio.position,
        attempts: studio.progress.attempts,
      };
      finishUnlock();
      await starting;
      expect(studio.transport.playing).toBe(false);
      expect(studio.song.id).toBe(expected.song);
      expect(studio.settings.mode).toBe(expected.mode);
      expect(studio.position).toBe(expected.position);
      expect(studio.progress.attempts).toBe(expected.attempts);
    },
  );

  it("does not sound a virtual key released while the piano was loading", async () => {
    const studio = create(song([[60, 0]]));
    let finish!: () => void;
    env.unlockWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    studio.virtual(60, true);
    studio.virtual(60, false);
    finish();
    await env.unlockWait;
    await Promise.resolve();
    await Promise.resolve();
    expect(studio.audio.tone).not.toHaveBeenCalled();
  });

  it("loops the whole song by default and keeps playing after the ending", async () => {
    const fixture = song([[60, 0.5]]);
    const studio = create(fixture);
    expect(studio.loopEnabled).toBe(true);
    expect(studio.transport.loop).toEqual([0, fixture.duration]);
    studio.mode("listen");
    await studio.play();
    vi.mocked(studio.audio.stop).mockClear();
    vi.mocked(studio.audio.schedule).mockClear();
    advance(studio, fixture.duration + 0.25);
    // Voices of the last pass end by the loop end, so the wrap lets them ring.
    expect(studio.audio.stop).not.toHaveBeenCalled();
    expect(studio.audio.schedule).toHaveBeenCalledOnce();
    expect(studio.transport.playing).toBe(true);
    expect(studio.position).toBeCloseTo(0.25);
  });

  it("restores an explicit loop-off preference without losing its custom bounds", () => {
    const fixture = song([[60, 1]]);
    const studio = create(fixture);
    studio.bounds(0.5, 2.5);
    studio.loop(false);
    studio.seek(3);
    studio.save();
    const restored = new Studio(fixtureLibrary());
    active.push(restored);
    restored.load(fixture);
    expect(restored.loopEnabled).toBe(false);
    expect(restored.transport.loop).toBeNull();
    expect(restored.position).toBe(3);
    expect([restored.loopStart, restored.loopEnd]).toEqual([0.5, 2.5]);
    restored.loop(true);
    expect(restored.transport.loop).toEqual([0.5, 2.5]);
  });

  it("ignores MIDI clock and active sensing without notifying views", async () => {
    const studio = create(song([[60, 1]]));
    studio.mode("listen");
    await studio.play();
    const listener = vi.fn();
    studio.subscribe(listener);
    const revision = studio.revision;
    // Clock, start, continue, stop, active sensing and reset.
    for (const status of [0xf8, 0xfa, 0xfb, 0xfc, 0xfe, 0xff])
      midi(studio, [status]);
    expect(listener).not.toHaveBeenCalled();
    expect(studio.revision).toBe(revision);
    midi(studio, [0x90, 60, 80]);
    expect(listener).toHaveBeenCalled();
    expect(studio.input.down.has(60)).toBe(true);
    expect(studio.lastVelocity).toBe(80);
  });

  it("replaces the song on hand assignment so views can memoize on it", () => {
    const studio = create(song([[60, 1]]));
    const before = studio.song;
    studio.assign(0, "left");
    expect(studio.song).not.toBe(before);
    expect(before.tracks[0].hand).toBe("right");
    expect(studio.song.tracks[0].hand).toBe("left");
    expect(studio.song.notes).toBe(before.notes);
    expect(studio.notes).toHaveLength(1);
  });

  it("persists position, speed, hand assignments, loop and feedback settings per song", () => {
    const fixture = song([
      [60, 1],
      [64, 2],
    ]);
    const studio = create(fixture);
    studio.assign(0, "left");
    studio.speed(0.5);
    studio.tolerance(0.35);
    studio.bounds(0.5, 2.5);
    studio.loop(true);
    studio.seek(1.5);
    studio.save();
    const restored = new Studio(fixtureLibrary());
    active.push(restored);
    restored.load(fixture);
    expect(restored.position).toBe(1.5);
    expect(restored.settings.speed).toBe(0.5);
    expect(restored.settings.tolerance).toBe(0.35);
    expect(restored.song.tracks[0].hand).toBe("left");
    expect(restored.transport.loop).toEqual([0.5, 2.5]);
  });

  /** `fixture` at 60 BPM, `duration` seconds long: the same notes on the same beats. */
  const slower = (fixture: Song, duration: number): Song => ({
    ...fixture,
    duration,
    tempos: [{ tick: 0, microseconds: 1_000_000 }],
    notes: fixture.notes.map((note) => ({
      ...note,
      start: note.start * 2,
      end: note.end * 2,
      soundEnd: note.soundEnd * 2,
    })),
  });
  const reopen = (fixture: Song) => {
    const restored = new Studio(fixtureLibrary());
    active.push(restored);
    restored.load(fixture);
    return restored;
  };
  const twoNotes = () =>
    song([
      [60, 1],
      [64, 2],
    ]);

  it("keeps a saved position and passage on their beats when the tempo changes", () => {
    const fixture = twoNotes();
    const studio = create(fixture);
    studio.bounds(0.5, 2.5);
    studio.seek(1.5);
    const key = `progress:${fixture.id}`,
      updated = "2026-01-01T00:00:00.000Z";
    env.values.set(key, { ...(env.values.get(key) as object), updated });
    // Every beat now lasts twice as long.
    const restored = reopen(slower(fixture, 8));
    expect(restored.position).toBe(3);
    expect([restored.loopStart, restored.loopEnd]).toEqual([1, 5]);
    expect(restored.transport.loop).toEqual([1, 5]);
    // The same beats: opening it saves nothing new.
    expect(restored.progress.updated).toBe(updated);
  });

  it("keeps a passage to the song's end at its end when the tempo changes", () => {
    const fixture = twoNotes();
    const studio = create(fixture);
    // At 60 BPM the song lasts 9 beats rather than 8.
    expect(reopen(slower(fixture, 9)).transport.loop).toEqual([0, 9]);
    studio.bounds(1, fixture.duration);
    expect(reopen(slower(fixture, 9)).transport.loop).toEqual([2, 9]);
  });

  it("starts the position and passage over when the song's notes change", () => {
    const studio = create(twoNotes());
    studio.assign(0, "left");
    studio.bounds(0.5, 2.5);
    studio.loop(false);
    studio.seek(1.5);
    const restored = reopen(
      song([
        [60, 1],
        [65, 2],
      ]),
    );
    expect(restored.position).toBe(0);
    expect([restored.loopStart, restored.loopEnd]).toEqual([0, 4]);
    // The rest of the song's progress stays.
    expect(restored.loopEnabled).toBe(false);
    expect(restored.song.tracks[0].hand).toBe("left");
  });
});

describe("sound through a MIDI output", () => {
  it("plays through the piano without starting browser audio, even when it cannot start", async () => {
    const studio = create(song([[60, 1]]));
    studio.mode("listen");
    output(studio);
    vi.mocked(studio.audio.unlock).mockRejectedValue(new Error("No audio"));
    await studio.play();
    expect(studio.audio.unlock).not.toHaveBeenCalled();
    expect(studio.audio.prepare).not.toHaveBeenCalled();
    expect(studio.transport.playing).toBe(true);
    expect(studio.notice).toBe("");
  });
});

describe("teacher duet", () => {
  const ids = (notes: readonly { id: string }[]) => notes.map((n) => n.id);
  /**
   * The notes the last audio schedule() call was given for this pass, or with
   * `next` for a loop's next pass.
   */
  const scheduled = (studio: Studio, next = false) => {
    const call = vi.mocked(studio.audio.schedule).mock.calls.at(-1);
    if (!call) return [];
    const [notes, , , ahead] = call;
    return ids(next ? (ahead ?? notes) : notes);
  };
  /** The notes the last MIDI tick was given. */
  const sent = (studio: Studio) => {
    const call = vi.mocked(studio.midi.player.schedule).mock.calls.at(-1);
    return call ? ids(call[0]) : [];
  };

  it("starts off, and moves the student part up the printed octaves when on", () => {
    const studio = create(duetSong());
    expect(studio.settings.duet).toBe(false);
    expect(studio.octaveShift).toBe(0);
    expect(studio.duetNotes).toEqual([]);
    expect(studio.song).toBe(studio.written);

    studio.duet();
    expect(studio.settings.duet).toBe(true);
    expect(env.values.get("settings")).toMatchObject({ duet: true });
    expect(studio.octaveShift).toBe(12);
    expect(studio.song.notes.map((n) => [n.id, n.pitch, n.finger])).toEqual([
      ["note-0", 72, 1],
      ["note-1", 76, 3],
    ]);
    expect(studio.notes.map((n) => n.pitch)).toEqual([72, 76]);
    expect(studio.practice.notes.map((n) => n.pitch)).toEqual([72, 76]);
    expect(studio.song.lesson!.handPositions).toEqual({
      left: "C position · C4 (5) to G4 (1)",
      right: "C position · C5 (1) to G5 (5)",
    });
    // The sheet keeps the book's notes.
    expect(studio.written.notes.map((n) => n.pitch)).toEqual([60, 64]);
    expect(ids(studio.duetNotes)).toEqual([
      "duet-0",
      "duet-1",
      "duet-2",
      "duet-3",
    ]);

    studio.duet();
    expect(studio.octaveShift).toBe(0);
    expect(studio.notes.map((n) => n.pitch)).toEqual([60, 64]);
  });

  it("moves the student part down when the book asks for it lower", () => {
    const fixture = duetSong();
    const studio = create({
      ...fixture,
      duet: { ...fixture.duet!, octaves: -1 },
    });
    studio.duet();
    expect(studio.octaveShift).toBe(-12);
    expect(studio.notes.map((n) => n.pitch)).toEqual([48, 52]);
    expect(studio.song.lesson!.handPositions.right).toBe(
      "C position · C3 (1) to G3 (5)",
    );
  });

  it("keeps a moved-up part through hand assignment and song changes", () => {
    const studio = create(duetSong());
    studio.duet();
    studio.assign(0, "left");
    expect(studio.song.tracks[0].hand).toBe("left");
    expect(studio.written.tracks[0].hand).toBe("left");
    expect(studio.notes.map((n) => n.pitch)).toEqual([72, 76]);
    studio.load(song([[60, 1]]));
    expect(studio.octaveShift).toBe(0);
    expect(studio.duetNotes).toEqual([]);
    expect(studio.notes.map((n) => n.pitch)).toEqual([60]);
    studio.load(duetSong());
    expect(studio.notes.map((n) => n.pitch)).toEqual([72, 76]);
  });

  it("never scores or waits for the duet part", async () => {
    const studio = create(duetSong());
    studio.duet();
    studio.tolerance(0.3);
    await studio.play();
    expect(studio.practice.gate?.notes.map((n) => n.id)).toEqual(["note-0"]);
    advance(studio, 1);
    // The teacher's C3 at this gate is not the student's note.
    midi(studio, [0x90, 48, 100]);
    expect(studio.practice.feedback.at(-1)?.kind).toBe("wrong");
    expect(studio.practice.gate?.start).toBe(1);
    midi(studio, [0x90, 72, 100]);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.practice.gate?.start).toBe(2);
  });

  it("holds the duet at each Wait gate and plays it on with the student's key", async () => {
    const studio = create(duetSong());
    studio.duet();
    await studio.play();
    advance(studio, 0.5);
    expect(scheduled(studio)).toEqual(["duet-0"]);
    advance(studio, 1);
    expect(studio.position).toBe(1);
    expect(studio.transport.held).toBe(true);
    // Waiting at the first gate holds back the teacher's notes from there on.
    expect(scheduled(studio)).toEqual(["duet-0"]);
    // Its sounding notes hold while the learner takes their time.
    expect(studio.audio.hold).toHaveBeenCalledOnce();
    const cycle = studio.transport.cycle;
    midi(studio, [0x90, 72, 100]);
    // They are scheduled at once, without striking sounding notes again, and
    // held notes end where they are written from here.
    expect(scheduled(studio)).toEqual(["duet-0", "duet-1", "duet-2"]);
    expect(studio.transport.cycle).toBe(cycle);
    expect(studio.audio.reschedule).toHaveBeenCalledOnce();
    advance(studio, 0.1);
    expect(studio.audio.hold).toHaveBeenCalledOnce();
  });

  it("sends only the teacher to MIDI in Wait for me, waits at gates and silences output on pause and seek", async () => {
    const studio = create(duetSong());
    output(studio);
    studio.duet();
    await studio.play();
    expect(studio.audio.prepare).not.toHaveBeenCalled();
    advance(studio, 1);
    expect(studio.audio.schedule).not.toHaveBeenCalled();
    let call = vi.mocked(studio.midi.player.schedule).mock.calls.at(-1)!;
    expect(ids(call[0])).toEqual(["duet-0"]);
    expect(call[3]).toBe(true);
    midi(studio, [0x90, 72, 100]);
    call = vi.mocked(studio.midi.player.schedule).mock.calls.at(-1)!;
    expect(ids(call[0])).toEqual(["duet-0", "duet-1", "duet-2"]);
    expect(call[3]).toBe(false);
    vi.mocked(studio.midi.player.stop).mockClear();
    studio.pause();
    expect(studio.midi.player.stop).toHaveBeenCalledOnce();
    studio.seek(0);
    expect(studio.midi.player.stop).toHaveBeenCalledTimes(2);
  });

  it("cancels a start still opening audio when its MIDI output is lost", async () => {
    const studio = create(duetSong());
    studio.mode("listen");
    output(studio);
    let finish!: () => void;
    env.unlockWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const starting = studio.play();
    output(studio, false);
    env.outputLosses.at(-1)!();
    expect(studio.notice).toMatch(/Piano output disconnected.*Press Play/);
    finish();
    await starting;
    expect(studio.transport.playing).toBe(false);
    expect(studio.audio.prepare).not.toHaveBeenCalled();
  });

  it("sounds a duet note a Wait loop seek lands in", async () => {
    const studio = create(duetSong());
    studio.duet();
    studio.bounds(0.5, 2.5);
    studio.seek(1.2);
    await studio.play();
    advance(studio, 0.01);
    // The teacher's note from 1 to 1.4 is sounding here.
    expect(scheduled(studio)).toEqual(["duet-0", "duet-1", "duet-2"]);
  });

  it("keeps the next loop pass's duet waiting at its first gate", async () => {
    const studio = create(duetSong());
    studio.duet();
    studio.bounds(0.5, 2.5);
    await studio.play();
    advance(studio, 0.5);
    midi(studio, [0x90, 72, 100]);
    midi(studio, [0x80, 72, 0]);
    advance(studio, 1);
    midi(studio, [0x90, 76, 100]);
    expect(studio.practice.gate).toBeUndefined();
    // This pass plays on to its end, including the teacher's note sounding
    // at the loop end, but the next pass may start only its notes before
    // its first gate.
    advance(studio, 0.2);
    expect(scheduled(studio)).toEqual(["duet-0", "duet-1", "duet-2", "duet-3"]);
    expect(scheduled(studio, true)).toEqual(["duet-0"]);
    advance(studio, 0.25);
    expect(scheduled(studio, true)).toEqual(["duet-0"]);
  });

  const student = ["note-0", "note-1"],
    teacher = ["duet-0", "duet-1", "duet-2", "duet-3"];
  /**
   * What each mode plays, with Duet off and on: the passage, and what sounds
   * 0.6 s in. Only Listen plays the student part. Wait for me holds the
   * teacher at the student's first note, at 1 s.
   */
  const plays = [
    ["listen", false, student, student],
    ["listen", true, [...student, ...teacher], [...student, ...teacher]],
    ["wait", false, [], []],
    ["wait", true, teacher, ["duet-0"]],
    ["rhythm", false, [], []],
    ["rhythm", true, teacher, teacher],
  ] as const;

  it.each(plays)(
    "in %s with Duet %s, plays %j on the laptop",
    async (mode, duet, passage, now) => {
      const studio = create(duetSong());
      if (duet) studio.duet();
      studio.mode(mode);
      await studio.play();
      const prepared = vi
        .mocked(studio.audio.setPlaybackNotes)
        .mock.calls.at(-1)![0] as readonly Note[];
      expect(ids(prepared)).toEqual(passage);
      if (!passage.length) expect(studio.audio.prepare).not.toHaveBeenCalled();
      advance(studio, 0.6);
      expect(scheduled(studio)).toEqual(now);
      expect(studio.midi.player.schedule).not.toHaveBeenCalled();
    },
  );

  it.each(plays)(
    "in %s with Duet %s, sends %j to a MIDI output and nothing to the laptop",
    async (mode, duet, _passage, now) => {
      const studio = create(duetSong());
      if (duet) studio.duet();
      studio.mode(mode);
      output(studio);
      await studio.play();
      expect(studio.audio.prepare).not.toHaveBeenCalled();
      expect(studio.audio.setPlaybackNotes).toHaveBeenLastCalledWith([], []);
      advance(studio, 0.6);
      expect(sent(studio)).toEqual(now);
      expect(studio.audio.schedule).not.toHaveBeenCalled();
    },
  );

  it("sends the song's sustain pedal to a MIDI output with the notes", async () => {
    const fixture: Song = {
      ...duetSong(),
      pedals: [{ channel: 0, start: 0.5, end: 1.5 }],
    };
    const studio = create(fixture);
    studio.mode("listen");
    output(studio);
    await studio.play();
    advance(studio, 0.6);
    const call = vi.mocked(studio.midi.player.schedule).mock.calls.at(-1)!;
    expect(call[1]).toBeCloseTo(0.6);
    expect(call[4]).toEqual(fixture.pedals);
  });

  it("keeps MIDI playback going when a laptop voice turns on", async () => {
    const studio = create(duetSong());
    studio.mode("listen");
    output(studio);
    await studio.play();
    studio.pianoVoice("resonance", false);
    studio.pianoVoice("resonance", true);
    expect(studio.transport.playing).toBe(true);
    expect(studio.audio.prepare).not.toHaveBeenCalled();
  });
});

describe("account sync hooks", () => {
  const hooks = () => ({
    settings: vi.fn(),
    progress: vi.fn(),
    practice: vi.fn(),
  });
  it("reports saved settings and progress to the account", () => {
    const sync = hooks();
    const studio = new Studio(fixtureLibrary(), sync);
    active.push(studio);
    studio.load(song([[60, 1]]));
    expect(sync.settings).toHaveBeenLastCalledWith(
      expect.objectContaining({ selected: "controller-fixture" }),
    );
    // Opening the song reports its save as the starting point.
    expect(sync.progress).toHaveBeenLastCalledWith(
      "controller-fixture",
      expect.any(Object),
      true,
    );
    // Saving with nothing changed neither restamps nor reports the record.
    const calls = sync.progress.mock.calls.length;
    const stamp = studio.progress.updated;
    studio.save();
    expect(sync.progress).toHaveBeenCalledTimes(calls);
    expect(studio.progress.updated).toBe(stamp);
    studio.seek(1);
    expect(sync.progress).toHaveBeenLastCalledWith(
      "controller-fixture",
      // One second in at 120 BPM.
      expect.objectContaining({ beat: 2, updated: expect.any(String) }),
      false,
    );
  });

  it("reports practice time to the account as it is saved", async () => {
    const sync = hooks();
    const studio = new Studio(fixtureLibrary(), sync);
    active.push(studio);
    studio.load(song([[60, 1]]));
    await studio.play();
    midi(studio, [0x90, 72, 80]);
    for (let i = 0; i < 3; i++) advance(studio, 1);
    studio.save();
    expect(sync.practice).toHaveBeenLastCalledWith(
      expect.objectContaining({
        day: studio.practiceLog.today(),
        seconds: 3,
        songs: { "controller-fixture": 3 },
      }),
    );
    // Nothing new to report when no time was added.
    const calls = sync.practice.mock.calls.length;
    studio.save();
    expect(sync.practice).toHaveBeenCalledTimes(calls);
  });
});

describe("the CD's story", () => {
  const narration = () => ({ stop: vi.fn() });

  it("stops as practice starts, before its piano sound loads", async () => {
    const studio = create(song([[60, 1]]));
    studio.mode("listen");
    const story = narration();
    studio.narration = story;
    let finish!: () => void;
    env.prepareWait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const playing = studio.play();
    expect(story.stop).toHaveBeenCalledOnce();
    expect(studio.transport.playing).toBe(false);
    finish();
    await playing;
    expect(studio.transport.playing).toBe(true);
    // Pausing leaves it be: nothing plays to stop.
    studio.pause();
    expect(story.stop).toHaveBeenCalledOnce();
  });

  it("keeps playing when Play has nothing to play", async () => {
    const studio = create(song([[60, 1]]));
    const story = narration();
    studio.narration = story;
    studio.hand("left");
    studio.hand("right");
    await studio.play();
    expect(studio.notice).toMatch(/Turn on Left, Right/);
    expect(story.stop).not.toHaveBeenCalled();
  });

  it("stops as another song opens and as the studio closes", () => {
    const studio = create(song([[60, 1]]));
    const story = narration();
    studio.narration = story;
    studio.load(song([[62, 1]], "another-song"));
    expect(story.stop).toHaveBeenCalledOnce();
    studio.destroy();
    expect(story.stop).toHaveBeenCalledTimes(2);
  });
});

describe("practice time", () => {
  // A wrong key holds Wait mode at its first note, so playback keeps running.
  const held = () => song([[60, 1]]);
  const today = (studio: Studio) =>
    studio.practiceLog.totals().get(studio.practiceLog.today()) ?? 0;

  it("counts playing time only while keys are being pressed", async () => {
    const studio = create(held());
    await studio.play();
    advance(studio, 1);
    advance(studio, 1);
    expect(today(studio)).toBe(0);
    midi(studio, [0x90, 72, 80]);
    midi(studio, [0x80, 72, 0]);
    for (let i = 0; i < 20; i++) advance(studio, 1);
    // Time stops counting 15 seconds after the last key press.
    expect(studio.transport.playing).toBe(true);
    expect(today(studio)).toBe(15);
    midi(studio, [0x90, 72, 80]);
    advance(studio, 1);
    expect(today(studio)).toBe(16);
  });

  it("leaves out Listen, paused time and long gaps between ticks", async () => {
    const studio = create(held());
    studio.mode("listen");
    await studio.play();
    midi(studio, [0x90, 72, 80]);
    advance(studio, 3);
    expect(today(studio)).toBe(0);
    studio.pause();

    studio.mode("wait");
    await studio.play();
    advance(studio, 0.5);
    midi(studio, [0x90, 74, 80]);
    advance(studio, 1);
    studio.pause();
    // The minute spent paused is not practice.
    env.now += 60;
    await studio.play();
    midi(studio, [0x90, 74, 80]);
    advance(studio, 0.5);
    // A stalled tick counts at most a second.
    advance(studio, 5);
    expect(today(studio)).toBe(2);
  });

  it("times key activity from when the key was pressed", async () => {
    const studio = create(held());
    await studio.play();
    advance(studio, 5);
    // Pressed before this playback run started, delivered late.
    midi(studio, [0x90, 72, 80], 8);
    for (let i = 0; i < 3; i++) advance(studio, 1);
    expect(today(studio)).toBe(0);
    advance(studio, 2);
    // Pressed 8 seconds before its delivery: 7 seconds of activity remain.
    midi(studio, [0x90, 74, 80], 8);
    for (let i = 0; i < 10; i++) advance(studio, 1);
    expect(today(studio)).toBe(7);
  });

  it("shows practice another tab saves, and listens again after a restart", () => {
    const studio = create(held());
    const emitted = vi.fn();
    studio.subscribe(emitted);
    env.values.set("practice:other", {
      id: "other",
      day: studio.practiceLog.today(),
      startedAt: "x",
      seconds: 120,
      songs: { ode: 120 },
    });
    for (const watcher of env.watchers) watcher();
    expect(today(studio)).toBe(120);
    expect(emitted).toHaveBeenCalled();
    studio.destroy();
    expect(env.watchers.size).toBe(0);
    // Saved while this studio was closed, then more after it reopens.
    const other = (seconds: number) => ({
      id: "other",
      day: studio.practiceLog.today(),
      startedAt: "x",
      seconds,
      songs: { ode: seconds },
    });
    env.values.set("practice:other", other(180));
    studio.init();
    expect(today(studio)).toBe(180);
    expect(env.watchers.size).toBe(1);
    env.values.set("practice:other", other(240));
    for (const watcher of env.watchers) watcher();
    expect(today(studio)).toBe(240);
  });

  it("needs a new key press after the studio restarts mid-playback", async () => {
    const studio = create(held());
    await studio.play();
    midi(studio, [0x90, 72, 80]);
    advance(studio, 1);
    expect(today(studio)).toBe(1);
    studio.destroy();
    studio.init();
    for (let i = 0; i < 3; i++) advance(studio, 1);
    expect(today(studio)).toBe(1);
    midi(studio, [0x90, 74, 80]);
    advance(studio, 1);
    expect(today(studio)).toBe(2);
  });

  it("needs a new key press after resuming playback", async () => {
    const studio = create(held());
    await studio.play();
    midi(studio, [0x90, 72, 80]);
    for (let i = 0; i < 2; i++) advance(studio, 1);
    expect(today(studio)).toBe(2);
    studio.pause();
    await studio.play();
    for (let i = 0; i < 3; i++) advance(studio, 1);
    expect(today(studio)).toBe(2);
    midi(studio, [0x90, 74, 80]);
    advance(studio, 1);
    expect(today(studio)).toBe(3);
  });

  it("ignores key presses made while paused or in Listen", async () => {
    const studio = create(held());
    midi(studio, [0x90, 72, 80]);
    await studio.play();
    for (let i = 0; i < 3; i++) advance(studio, 1);
    expect(today(studio)).toBe(0);
    studio.pause();

    studio.mode("listen");
    await studio.play();
    midi(studio, [0x90, 72, 80]);
    studio.pause();
    studio.mode("wait");
    await studio.play();
    for (let i = 0; i < 3; i++) advance(studio, 1);
    expect(today(studio)).toBe(0);
  });

  it("saves practice sessions in browser storage as they grow", async () => {
    const studio = create(held());
    await studio.play();
    midi(studio, [0x90, 72, 80]);
    for (let i = 0; i < 4; i++) advance(studio, 1);
    studio.pause();
    const sessions = [...env.values].filter(([key]) =>
      key.startsWith("practice:"),
    );
    expect(sessions).toEqual([
      [
        expect.any(String),
        expect.objectContaining({
          seconds: 4,
          songs: { "controller-fixture": 4 },
          day: studio.practiceLog.today(),
        }),
      ],
    ]);
    expect(sessions[0][0]).toBe(
      `practice:${(sessions[0][1] as { id: string }).id}`,
    );
  });

  it("saves the learner's name and a daily goal from the choices", () => {
    const studio = create();
    expect(studio.settings.learnerNameChosen).toBe(false);
    studio.learnerName("");
    // Even a blank name counts as chosen, so it is kept.
    expect(env.values.get("settings")).toMatchObject({
      learnerName: "",
      learnerNameChosen: true,
    });
    studio.learnerName("George");
    studio.dailyGoal(15);
    studio.dailyGoal(7);
    const saved = { learnerName: "George", dailyGoalMinutes: 15 };
    expect(studio.settings).toMatchObject(saved);
    expect(env.values.get("settings")).toMatchObject(saved);
  });
});

describe("metronome", () => {
  /** A studio in `mode` with the metronome on. The fixture is 4/4 at 120 BPM. */
  function clicking(fixture: Song, mode: Mode = "rhythm") {
    const studio = create(fixture);
    studio.mode(mode);
    studio.click();
    return studio;
  }
  /** Advance in practice ticks of 20 ms. */
  function run(studio: Studio, seconds: number) {
    for (let t = 0; t < seconds - 1e-9; t += 0.02) advance(studio, 0.02);
  }
  it("is remembered, and stays off in Wait for me", async () => {
    const studio = create(song([[60, 0.5]]));
    studio.click();
    expect(env.values.get("settings")).toMatchObject({ click: true });
    // Wait for me keeps no beat, so Play starts at once.
    expect(studio.clicking).toBe(false);
    await studio.play();
    expect(studio.transport.playing).toBe(true);
    studio.mode("listen");
    expect(studio.clicking).toBe(true);
  });
  it("counts in a bar, then plays from where the count ends", async () => {
    const studio = clicking(song([[60, 0.5]]));
    await studio.play();
    // From the first beat, the whole bar before it: 2 s, after a short delay.
    expect(studio.playing).toBe(true);
    expect(studio.transport.playing).toBe(false);
    advance(studio, 2.05);
    expect(studio.transport.playing).toBe(false);
    expect(studio.position).toBe(0);
    advance(studio, 0.07);
    expect(studio.transport.playing).toBe(true);
    expect(studio.position).toBeCloseTo(0.02);
  });
  it("clicks on the laptop while the piano plays the music", async () => {
    const tick = vi.spyOn(Metronome.prototype, "tick");
    const studio = clicking(song([[60, 0.5]]), "listen");
    output(studio);
    await studio.play();
    // Browser audio starts for the click alone: no piano samples load.
    expect(studio.audio.unlock).toHaveBeenCalledOnce();
    expect(studio.audio.prepare).not.toHaveBeenCalled();
    run(studio, 2.7);
    expect(studio.transport.playing).toBe(true);
    const positions = tick.mock.calls.map(([, clock]) => clock.position);
    // The count-in, from a bar before the song, then the song.
    expect(positions[0]).toBeCloseTo(-2.08);
    expect(positions.at(-1)).toBeCloseTo(0.6);
    // Turned off, it stops; the music plays on.
    studio.click();
    const calls = tick.mock.calls.length;
    run(studio, 1);
    expect(tick).toHaveBeenCalledTimes(calls);
    expect(studio.transport.playing).toBe(true);
  });
  it("plays on the piano without the click when browser audio cannot start", async () => {
    const studio = clicking(song([[60, 0.5]]), "listen");
    output(studio);
    vi.mocked(studio.audio.unlock).mockRejectedValue(new Error("No audio"));
    await studio.play();
    // At once: a count-in would be silent.
    expect(studio.transport.playing).toBe(true);
    advance(studio, 0.5);
    expect(studio.position).toBeCloseTo(0.5);
    expect(studio.notice).toBe("");
  });
  it("counts in when turned on during playback, starting browser audio for it", async () => {
    const studio = create(song([[60, 0.5]]));
    studio.mode("listen");
    output(studio);
    await studio.play();
    expect(studio.audio.unlock).not.toHaveBeenCalled();
    advance(studio, 1);
    studio.click();
    await vi.waitFor(() => expect(studio.playing).toBe(true));
    expect(studio.audio.unlock).toHaveBeenCalledOnce();
    expect(studio.transport.playing).toBe(false);
    // From the third beat: the bar's first two, then on from there.
    advance(studio, 1.05);
    expect(studio.transport.playing).toBe(false);
    advance(studio, 0.1);
    expect(studio.transport.playing).toBe(true);
    expect(studio.position).toBeCloseTo(1.05);
  });
  it("counts in once when Play starts over from the song's end", async () => {
    const studio = clicking(song([[60, 0.5]]), "listen");
    studio.loop(false);
    studio.seek(4);
    await studio.play();
    await new Promise((resolve) => setTimeout(resolve));
    expect(studio.audio.prepare).toHaveBeenCalledOnce();
    expect(studio.progress.attempts).toBe(1);
    expect(studio.position).toBe(0);
    expect(studio.playing).toBe(true);
    expect(studio.transport.playing).toBe(false);
  });
  it("cancels the count-in on pause, and counts again from a seek", async () => {
    const studio = clicking(song([[60, 0.5]]));
    await studio.play();
    advance(studio, 1);
    studio.pause();
    expect(studio.playing).toBe(false);
    advance(studio, 2);
    expect(studio.transport.playing).toBe(false);
    await studio.play();
    advance(studio, 1);
    // From the third beat: the bar's first two, 1 s.
    studio.seek(1);
    await vi.waitFor(() => expect(studio.playing).toBe(true));
    advance(studio, 1.05);
    expect(studio.transport.playing).toBe(false);
    advance(studio, 0.1);
    expect(studio.transport.playing).toBe(true);
    expect(studio.position).toBeCloseTo(1.05);
  });
  it("plays at once when turned off during the count-in", async () => {
    const studio = clicking(song([[60, 0.5]]));
    await studio.play();
    advance(studio, 1);
    studio.click();
    expect(studio.transport.playing).toBe(true);
    advance(studio, 0.5);
    expect(studio.position).toBeCloseTo(0.5);
  });
  it("counts in again after a seek during playback", async () => {
    const studio = clicking(song([[60, 0.5]]));
    await studio.play();
    run(studio, 2.2);
    expect(studio.transport.playing).toBe(true);
    studio.seek(1);
    await vi.waitFor(() => expect(studio.playing).toBe(true));
    expect(studio.transport.playing).toBe(false);
    expect(studio.position).toBe(1);
    // The bar's first two beats, 1 s, then playback from the seek.
    advance(studio, 1.05);
    expect(studio.transport.playing).toBe(false);
    advance(studio, 0.1);
    expect(studio.transport.playing).toBe(true);
    expect(studio.position).toBeCloseTo(1.05);
  });
  it("cancels the clicks the last tick before a pause scheduled", async () => {
    const tick = vi.spyOn(Metronome.prototype, "tick"),
      stop = vi.spyOn(Metronome.prototype, "stop");
    const studio = clicking(song([[60, 0.5]]));
    await studio.play();
    run(studio, 2.2);
    studio.pause();
    const last = (spy: typeof tick | typeof stop) =>
      spy.mock.invocationCallOrder.at(-1)!;
    expect(last(stop)).toBeGreaterThan(last(tick));
  });
  it("carries a count-in on at a new speed", async () => {
    const studio = clicking(song([[60, 0.5]]));
    await studio.play();
    advance(studio, 1.1);
    // Halfway through the bar at full speed; the other half takes 2 s.
    studio.speed(0.5);
    advance(studio, 1.95);
    expect(studio.transport.playing).toBe(false);
    advance(studio, 0.1);
    expect(studio.transport.playing).toBe(true);
    expect(studio.position).toBeCloseTo(0.025);
  });
  it("scores a Rhythm press early for the first note as the count-in ends", async () => {
    const studio = clicking(
      song([
        [60, 0],
        [62, 0.5],
      ]),
    );
    await studio.play();
    advance(studio, 1);
    // Long before the music: no score.
    midi(studio, [0x90, 62, 100]);
    midi(studio, [0x80, 62, 0]);
    advance(studio, 1);
    // 100 ms before playback starts.
    midi(studio, [0x90, 60, 100]);
    midi(studio, [0x80, 60, 0]);
    expect(studio.practice.feedback).toMatchObject([
      { kind: "early", pitch: 60, offset: expect.closeTo(-0.1) },
    ]);
    run(studio, 0.6);
    expect(studio.practice.hit).toEqual(new Set(["note-0"]));
    expect(studio.practice.missed).toEqual(new Set());
  });
});

describe("key listeners", () => {
  it("tells listeners each key going down and coming up, once", () => {
    const studio = create();
    const keys: [number, boolean][] = [];
    const stop = studio.onKey((pitch, down) => keys.push([pitch, down]));
    midi(studio, [0x90, 36, 80]);
    // A repeated note-on is not a new press.
    midi(studio, [0x90, 36, 80]);
    midi(studio, [0x80, 36, 0]);
    // Releasing a key that is not down tells nobody.
    midi(studio, [0x80, 60, 0]);
    // A key let go under the pedal still comes up.
    midi(studio, [0xb0, 64, 127]);
    midi(studio, [0x90, 62, 70]);
    midi(studio, [0x90, 62, 0]);
    stop();
    midi(studio, [0x90, 40, 80]);
    expect(keys).toEqual([
      [36, true],
      [36, false],
      [62, true],
      [62, false],
    ]);
  });

  it("drops an Ear Detective example stopped while its sound loads", async () => {
    const studio = create();
    Object.assign(studio.audio, {
      context: { state: "running", currentTime: 0 },
    });
    const note = [{ pitch: 60, start: 0, duration: 0.5 }];
    let loaded!: () => void;
    env.unlockWait = new Promise<void>((resolve) => (loaded = resolve));
    const first = studio.playExample(note, 0, 0.6);
    // The page restarts before the sound has loaded.
    studio.stopExample();
    env.unlockWait = null;
    loaded();
    expect(await first).toBeNull();
    expect(studio.audio.tone).not.toHaveBeenCalled();
    expect(await studio.playExample(note, 0, 0.6)).not.toBeNull();
    expect(studio.audio.tone).toHaveBeenCalledOnce();
  });

  it("plays an Ear Detective melody on the piano without browser audio", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const studio = create();
    output(studio);
    vi.mocked(studio.audio.unlock).mockRejectedValue(new Error("blocked"));
    const note = [{ pitch: 60, start: 0, duration: 0.5 }];
    expect(await studio.playExample(note, 0, 0.6)).toBe(env.now * 1000 + 650);
    vi.advanceTimersByTime(200);
    expect(studio.midi.player.keyDown).toHaveBeenCalledWith(
      60,
      expect.any(Number),
    );
    vi.useRealTimers();
  });

  it("stops an Ear Detective example when the sound output changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const studio = create();
    output(studio);
    const note = [{ pitch: 60, start: 0, duration: 0.5 }];
    await studio.playExample(note, 0, 0.6);
    await studio.soundOutput("");
    vi.advanceTimersByTime(1000);
    await studio.playExample(note, 0, 0.6);
    env.outputLosses.at(-1)!();
    vi.advanceTimersByTime(1000);
    expect(studio.midi.player.keyDown).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("lets listeners hear keys come up when they are released together", () => {
    const studio = create();
    const keys: [number, boolean, boolean | undefined][] = [];
    studio.onKey((pitch, down, _time, lost) => keys.push([pitch, down, lost]));
    studio.virtual(60, true);
    studio.releaseKeys();
    // The release is marked lost: the key itself was never let go.
    expect(keys).toEqual([
      [60, true, undefined],
      [60, false, true],
    ]);
  });

  it("gives each key the time it was played, not when it was handled", () => {
    const studio = create();
    const times: number[] = [];
    studio.onKey((_pitch, down, time) => down && times.push(time));
    // Two presses 0.3 s apart, handled together now.
    midi(studio, [0x90, 60, 80], 0.5);
    midi(studio, [0x90, 64, 80], 0.2);
    expect(times).toEqual([(env.now - 0.5) * 1000, (env.now - 0.2) * 1000]);
  });
});
