import {
  Practice,
  Transport,
  MidiState,
  TIMING_EPSILON,
  type Mode,
} from "./engine";
import { PianoAudio } from "./audio";
import { MidiConnection } from "./midi";
import {
  songVersion,
  type Note,
  type PedalSpan,
  type Song,
  type Hand,
} from "./song";
import { createBeatClock } from "./timeline";
import { normalizePianoSound, type PianoVoice } from "./pianoSound";
import {
  settings,
  write,
  progress,
  DAILY_GOAL_CHOICES,
  LEARNER_NAME_MAX,
  type Progress,
} from "./storage";
import type { SyncHooks } from "./cloud";
import { IDLE_SECONDS, PracticeLog, watchSessions } from "./practiceLog";
import {
  createClickTrack,
  Metronome,
  playClap,
  playClick,
  type ClickClock,
  type ClickTrack,
} from "./metronome";
const SOUND_UNAVAILABLE = "Piano sound is unavailable. Please try again.";
/** How hard on-screen keys and computer shortcuts strike, from 0 to 1. */
const KEY_VELOCITY = 0.6;
/** A progress record's content, leaving out when it was saved. */
const unstamped = ({ updated: _updated, ...rest }: Progress) =>
  JSON.stringify(rest);
/**
 * Beats as progress saves them. Loading turns them into seconds; rounding
 * turns those back into the same beats, so an untouched song saves unchanged.
 */
const savedBeat = (beat: number) => Math.round(beat * 1e6) / 1e6;
const NO_PEDALS: readonly PedalSpan[] = [];
/**
 * A key went down or came up at `time`: milliseconds on the performance
 * clock, as MIDI event time stamps are. `lost` marks a key-up that did not
 * come from the key, as when the window loses focus.
 */
export type KeyListener = (
  pitch: number,
  down: boolean,
  time: number,
  lost?: boolean,
) => void;
const NO_NOTES: Note[] = [];
/** How long after Play the count-in's first click sounds, in seconds. */
const COUNT_IN_DELAY = 0.1;
export class Studio {
  settings = settings();
  private playGeneration = 0;
  private playbackPending = false;
  outputChanging = false;
  private midiRouted = false;
  private audioPreparations = new Set<AbortController>();
  private virtualRequests = new Map<number, number>();
  private nextVirtualRequest = 0;
  private destroyed = false;
  private selectedNotes: Song["notes"] = [];
  scoringEpoch = 0;
  // Where the current loop pass began. Earlier presses in this scoring
  // session belong to the previous pass.
  private passEpoch = -Infinity;
  /** The shared song library, in library order. */
  songs: Song[];
  song: Song;
  /** The song as printed. With Duet on, `song` has its student part moved up. */
  written: Song;
  audio = new PianoAudio();
  private metronome = new Metronome();
  /** The current song's metronome clicks. */
  private clicks: ClickTrack;
  /**
   * The count-in before playback starts: song time `from` at audio-clock
   * time `anchor`, counting at the transport's speed up to `to`, where
   * playback starts.
   */
  private countIn: { from: number; to: number; anchor: number } | null = null;
  /** Where the metronome's current pass begins: a play position or loop start. */
  private clickFrom = 0;
  input = new MidiState();
  transport: Transport;
  practice: Practice;
  midi: MidiConnection;
  position = 0;
  notice = "";
  storageNotice = "";
  lastVelocity = 0;
  revision = 0;
  listeners = new Set<() => void>();
  /** Told of every key that goes down or comes up, as the workbook needs. */
  private keyListeners = new Set<KeyListener>();
  lastSave = 0;
  /** The current song's record as last written, without its stamp. */
  private savedProgress = "";
  /** Playing time per day, for the practice calendar, kept in the account too. */
  practiceLog = new PracticeLog(undefined, (session) =>
    this.sync?.practice(session),
  );
  /** When a key was last pressed, on the audio clock. */
  private lastKeyAt = -Infinity;
  /** The previous tick while practice time was being counted. */
  private lastPracticeTick: number | null = null;
  /** Stops following other tabs' practice; see watchPractice(). */
  private unwatchPractice = () => {};
  /**
   * The course CD's story (src/story.ts), which plays apart from practice: it
   * stops as practice starts, another song opens or the studio closes, so it
   * never sounds with the piano part.
   */
  narration: { stop(): void } | null = null;
  progress: Progress = {
    beat: 0,
    best: 0,
    attempts: 0,
    updated: "",
    assignments: {},
    loopEnabled: true,
    loopBeats: null,
    version: "",
  };
  /** The song's tempo map. Progress is saved in beats, which keep their bars. */
  private clock: ReturnType<typeof createBeatClock>;
  loopEnabled = true;
  loopStart = 0;
  loopEnd: number;
  timer: ReturnType<typeof setInterval> | null = null;
  /**
   * `library` holds the shared songs (see src/library.ts). `sync` copies
   * saved changes to the signed-in account.
   */
  constructor(
    library: readonly Song[],
    private sync?: SyncHooks,
  ) {
    if (!library.length) throw new Error("The song library is empty.");
    this.songs = [...library];
    // Start on the saved song, if it is still in the library.
    this.song =
      this.songs.find((song) => song.id === this.settings.selected) ??
      this.songs[0];
    this.written = this.song;
    this.clicks = createClickTrack(this.song);
    this.transport = new Transport(this.song.duration);
    this.practice = new Practice(this.song.notes);
    this.loopEnd = this.song.duration;
    this.clock = createBeatClock(this.song.ppq, this.song.tempos);
    this.audio.setSound({
      ambience: this.settings.ambience,
      voices: this.settings.pianoVoices,
    });
    this.midi = this.createMidi();
    this.watchPractice();
    this.load(this.song);
  }
  /** Another tab's practice shows here too, without waiting for this one. */
  private watchPractice() {
    this.unwatchPractice = watchSessions(() => {
      if (this.practiceLog.refresh()) this.emit();
    });
  }
  private createMidi() {
    return new MidiConnection({
      onMessage: (data, time) => this.receive(data, time),
      onReset: () => {
        this.input.clear();
        if (this.settings.mode !== "listen") {
          if (this.playing || this.playbackPending) {
            this.pause();
            this.notice =
              "Piano connection changed. Press Play when you are ready.";
          } else this.cancelPlaybackPreparation();
        }
        this.emit();
      },
      onChange: () => this.emit(),
      onOutputChosen: (id, opened) => void this.followOutput(id, () => opened),
      onOutputLost: () => {
        // A workbook example sent its notes there too: press C2 again.
        this.stopExample();
        // Playback, or a start still loading, sent its notes to the lost
        // output and never prepared their laptop sound: stop, and let Play
        // start over on the laptop.
        if (
          this.destroyed ||
          !this.midiRouted ||
          !(this.playing || this.playbackPending)
        )
          return;
        this.pause();
        this.notice = "Piano output disconnected. Press Play to continue.";
        this.emit();
      },
    });
  }
  /** Send all sound to output `id`, or to the laptop with "". */
  async soundOutput(id: string) {
    if (this.outputChanging) return;
    await this.followOutput(id, () => this.midi.selectOutput(id));
  }
  /**
   * Pause while the output changes to `id` ("" is the laptop), then play on
   * from here once the change settles, unless the output failed to open.
   * Play waits for it too (see play()), so no run starts on the old routing.
   */
  private async followOutput(id: string, change: () => Promise<void>) {
    this.outputChanging = true;
    this.emit();
    const resume = this.playing || this.playbackPending;
    this.pause();
    // A workbook example does not move: it stops, to be heard again.
    this.stopExample();
    const generation = this.playGeneration;
    try {
      await change();
    } finally {
      this.outputChanging = false;
      this.emit();
    }
    if (
      resume &&
      !this.destroyed &&
      generation === this.playGeneration &&
      (!id || this.midi.player.connected)
    )
      await this.play();
  }
  get scoringNotes() {
    return this.notes.filter(
      (n) =>
        !this.loopEnabled ||
        (n.start >= this.loopStart - 0.001 && n.start < this.loopEnd),
    );
  }
  /**
   * Whether the app plays the student part: only Listen does. In Wait for me
   * and Rhythm the student plays it.
   */
  private get listening() {
    return this.settings.mode === "listen";
  }
  /** Notes that sound within the passage: all of them without a loop. */
  private inPassage(notes: readonly Note[]) {
    return notes.filter(
      (note) =>
        !this.loopEnabled ||
        (note.start < this.loopEnd && note.soundEnd > this.loopStart),
    );
  }
  /** The teacher part that plays along, with Duet on. */
  get duetNotes(): readonly Note[] {
    return (this.settings.duet && this.song.duet?.notes) || NO_NOTES;
  }
  /** How far Duet moves the student part, in semitones: negative is lower. */
  get octaveShift() {
    return this.settings.duet && this.written.duet
      ? 12 * this.written.duet.octaves
      : 0;
  }
  /** What playback sounds with `duet`: the student part in Listen, and `duet`. */
  private withStudent(duet: readonly Note[]): readonly Note[] {
    if (!this.listening) return duet;
    return duet.length ? [...this.notes, ...duet] : this.notes;
  }
  /** Whether playback sounds anything on the laptop, without a MIDI output. */
  private get audible() {
    return (
      !this.midi.player.connected &&
      (this.listening || this.duetNotes.length > 0)
    );
  }
  /**
   * Whether the metronome clicks: not in Wait for me, where the music waits
   * for the student instead of keeping a beat.
   */
  get clicking() {
    return this.settings.click && this.settings.mode !== "wait";
  }
  /** Whether playback runs, or counts in to start. */
  get playing() {
    return this.transport.playing || this.countIn !== null;
  }
  /** Wait mode holds the transport at the next chord. */
  private get waitGate() {
    return this.settings.mode === "wait"
      ? this.practice.gate?.start
      : undefined;
  }
  /** Score afresh from the current position, with no keys held. */
  private restartScoring() {
    this.scoringEpoch = this.audio.now();
    this.input.clear();
    this.practice = new Practice(this.scoringNotes, this.transport.loop);
    this.practice.reset(this.position);
  }
  /** Cancel a start still loading or counting in, and the clicks to come. */
  private cancelPlaybackPreparation() {
    this.playGeneration++;
    this.playbackPending = false;
    this.countIn = null;
    this.metronome.stop(this.audio.now());
    for (const preparation of this.audioPreparations) preparation.abort();
    this.audioPreparations.clear();
  }
  get notes() {
    return this.selectedNotes;
  }
  private refreshSelection() {
    const hands = new Map(this.song.tracks.map((t) => [t.id, t.hand]));
    this.selectedNotes = this.song.notes.filter((n) => {
      const hand = hands.get(n.track);
      return hand === "left"
        ? this.settings.left
        : hand === "right" && this.settings.right;
    });
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.revision;
  /**
   * One metronome click now, on the laptop, as the workbook's Hold It! game
   * counts beats. A click that cannot play is left out.
   */
  beat(accent = false) {
    void this.audio
      .unlock()
      .then(() => {
        const context = this.audio.context;
        if (context?.state === "running")
          playClick(context, context.currentTime, accent);
      })
      .catch(() => {});
  }
  /** The workbook's playing, to stop when another starts or a page closes. */
  private examplePlaying: { stop(): void } | null = null;
  /** Counts examples started and stopped: a start still loading gives up. */
  private exampleRun = 0;
  /**
   * Play an Ear Detective example: `countIn` metronome clicks a beat apart,
   * then each sound: a clap on the laptop where it has no pitch, else a note
   * in the piano's sound (on the piano's own output when one is chosen).
   * Resolves with when the playing ends, in performance-clock milliseconds,
   * or null if it could not start or was stopped while its sound loaded.
   */
  async playExample(
    sounds: readonly { pitch?: number; start: number; duration: number }[],
    countIn: number,
    beat: number,
  ): Promise<number | null> {
    this.stopExample();
    this.pause();
    const run = this.exampleRun;
    const notes = sounds.filter(
      (s): s is typeof s & { pitch: number } => s.pitch !== undefined,
    );
    const generation = this.playGeneration;
    // On a piano output, a melody with no count-in needs no browser audio,
    // which may be unavailable, as for a song routed there.
    const routed = this.midi.player.connected,
      pianoOnly = routed && countIn === 0 && notes.length === sounds.length;
    try {
      if (!routed)
        await this.prepareAudio(
          notes.map(({ pitch }) => ({ pitch, velocity: KEY_VELOCITY })),
          generation,
        );
      else if (!pianoOnly) await this.audio.unlock();
    } catch {
      return null;
    }
    // Another example, or the page closing, came while the sound loaded.
    if (run !== this.exampleRun) return null;
    const context =
      this.audio.context?.state === "running" ? this.audio.context : null;
    if (!context && !pianoOnly) return null;
    // Times are in seconds from now; laptop sounds add the audio clock's now.
    const now = context?.currentTime ?? 0,
      lead = 0.15,
      from = lead + countIn * beat,
      timers: ReturnType<typeof setTimeout>[] = [],
      sources: AudioScheduledSourceNode[] = [];
    if (context)
      for (let i = 0; i < countIn; i++)
        sources.push(playClick(context, now + lead + i * beat, i === 0).source);
    for (const sound of sounds) {
      const when = from + sound.start;
      if (routed && sound.pitch !== undefined) {
        const pitch = sound.pitch,
          delay = when * 1000;
        timers.push(
          setTimeout(
            () => this.midi.player.keyDown(pitch, KEY_VELOCITY),
            delay,
          ),
          setTimeout(
            () => this.midi.player.keyUp(pitch),
            delay + sound.duration * 1000,
          ),
        );
      } else if (context) {
        if (sound.pitch === undefined)
          sources.push(playClap(context, now + when));
        else
          this.audio.tone(
            sound.pitch,
            KEY_VELOCITY,
            now + when,
            sound.duration,
          );
      }
    }
    const end = Math.max(
      from,
      ...sounds.map((s) => from + s.start + s.duration),
    );
    this.examplePlaying = {
      stop: () => {
        for (const timer of timers) clearTimeout(timer);
        for (const source of sources)
          try {
            source.stop();
          } catch {
            // Already stopped.
          }
        for (const note of notes) this.midi.player.keyUp(note.pitch);
        this.audio.stop();
      },
    };
    return performance.now() + end * 1000;
  }
  /** Stop the workbook's playing, as a page closes. */
  stopExample() {
    this.exampleRun++;
    this.examplePlaying?.stop();
    this.examplePlaying = null;
  }
  /**
   * Follow key presses and releases from the piano, the screen and
   * shortcuts, each with when it happened.
   */
  onKey = (listener: KeyListener) => {
    this.keyListeners.add(listener);
    return () => this.keyListeners.delete(listener);
  };
  emit() {
    this.revision++;
    for (const l of this.listeners) l();
  }
  /** Start the practice clock and look for a piano, again after destroy(). */
  init() {
    if (this.timer !== null) return;
    if (this.destroyed) {
      this.midi = this.createMidi();
      this.watchPractice();
      // Take in what other tabs saved while this studio was closed.
      this.practiceLog.refresh();
      this.destroyed = false;
    }
    void this.midi.autoConnect();
    this.timer = setInterval(() => this.tick(), 20);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelPlaybackPreparation();
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.save();
    // A restart begins a new playback run, which needs its own key press.
    this.lastPracticeTick = null;
    this.narration?.stop();
    this.midi.player.stop();
    this.audio.stop();
    this.midi.dispose();
    this.unwatchPractice();
  }
  persist() {
    if (!write("settings", this.settings))
      this.storageNotice =
        "Browser storage is full or blocked. Changes will last for this session.";
    this.sync?.settings(this.settings);
  }
  /** `loaded`: this save is made as the song opens, before any practice. */
  save(loaded = false) {
    // Practice time grows on its own, so it is saved even when progress has
    // not changed.
    if (!this.practiceLog.commit())
      this.storageNotice = "Practice time could not be saved in this browser.";
    const next: Progress = {
      ...this.progress,
      beat: savedBeat(this.clock.at(this.position)),
      assignments: Object.fromEntries(
        this.song.tracks.map((t) => [t.id, t.hand]),
      ),
      loopEnabled: this.loopEnabled,
      // A passage to the end stays at the end, wherever a tempo change puts it.
      loopBeats: [
        savedBeat(this.clock.at(this.loopStart)),
        this.loopEnd >= this.song.duration
          ? null
          : savedBeat(this.clock.at(this.loopEnd)),
      ],
    };
    // Only a change gets a new stamp and is written: the account keeps the
    // position of the later save, so re-saving what was loaded must not look
    // newer than practice saved since on another device.
    if (unstamped(next) === this.savedProgress) {
      if (loaded) this.sync?.progress(this.song.id, this.progress, true);
      return;
    }
    this.progress = { ...next, updated: new Date().toISOString() };
    this.savedProgress = unstamped(next);
    if (!write(`progress:${this.song.id}`, this.progress))
      this.storageNotice = "Progress could not be saved in this browser.";
    this.sync?.progress(this.song.id, this.progress, loaded);
  }
  load(song: Song) {
    this.narration?.stop();
    this.cancelPlaybackPreparation();
    if (this.transport.playing) this.pause();
    this.midi.player.stop();
    this.audio.stop();
    this.written = { ...song, tracks: song.tracks.map((t) => ({ ...t })) };
    this.clicks = createClickTrack(song);
    this.settings.selected = song.id;
    this.persist();
    this.clock = createBeatClock(song.ppq, song.tempos);
    // The version of the notes as written: Duet only moves them for practice.
    // The length is rounded as saves are, so a position saved at the very
    // end loads unchanged.
    this.progress = progress(
      song.id,
      songVersion(song),
      savedBeat(this.clock.at(song.duration)),
    );
    this.savedProgress = this.progress.updated ? unstamped(this.progress) : "";
    for (const t of this.written.tracks) {
      const hand = this.progress.assignments[t.id];
      if (["left", "right", "off"].includes(hand)) t.hand = hand as Hand;
    }
    this.song = this.practiced();
    this.transport = new Transport(song.duration);
    this.transport.speed = this.settings.speed;
    const seconds = (beat: number) =>
        Math.max(0, Math.min(song.duration, this.clock.time(beat))),
      loop = this.progress.loopBeats;
    this.position = seconds(this.progress.beat);
    this.transport.seek(this.position, this.audio.now());
    this.loopStart = loop ? seconds(loop[0]) : 0;
    this.loopEnd = loop && loop[1] !== null ? seconds(loop[1]) : song.duration;
    this.loopEnabled = this.progress.loopEnabled;
    this.syncLoop();
    this.refreshSelection();
    this.restartScoring();
    this.notice = "";
    // The account's starting point for this song, so closing it untouched
    // uploads nothing.
    this.save(true);
    this.emit();
  }
  rebuild() {
    this.cancelPlaybackPreparation();
    this.refreshSelection();
    this.midi.player.stop();
    this.audio.stop();
    this.restartScoring();
    this.transport.seek(this.position, this.audio.now());
    this.save();
    this.persist();
    this.emit();
  }
  mode(mode: Mode) {
    this.pause();
    this.settings.mode = mode;
    this.rebuild();
  }
  /** Each hand turns on and off on its own; both may be off. */
  hand(hand: "left" | "right") {
    this.pause();
    this.settings[hand] = !this.settings[hand];
    this.rebuild();
  }
  /** The teacher duet turns on and off; the student part moves with it. */
  duet() {
    this.pause();
    this.settings.duet = !this.settings.duet;
    this.song = this.practiced();
    this.rebuild();
  }
  /**
   * The written song, or with Duet on, the student part as the book has it
   * played with the duet: an octave or two up or down, with its hand
   * positions.
   */
  private practiced(): Song {
    const written = this.written,
      shift = this.octaveShift;
    if (!shift) return written;
    const raise = (text: string) =>
      text.replace(
        /\b([A-G])(\d)\b/g,
        (_, name, octave) => `${name}${Number(octave) + shift / 12}`,
      );
    return {
      ...written,
      notes: written.notes.map((note) => ({
        ...note,
        pitch: note.pitch + shift,
      })),
      lesson: written.lesson && {
        ...written.lesson,
        handPositions: {
          left: raise(written.lesson.handPositions.left),
          right: raise(written.lesson.handPositions.right),
        },
      },
    };
  }
  assign(track: number, hand: Hand) {
    this.pause();
    // Replace rather than mutate, so views can memoize on the song's identity.
    this.written = {
      ...this.written,
      tracks: this.written.tracks.map((t) =>
        t.id === track ? { ...t, hand } : t,
      ),
    };
    this.song = this.practiced();
    this.rebuild();
  }
  speed(speed: number) {
    const now = this.audio.now();
    if (this.transport.playing) this.tick(now);
    // A count-in carries on from where it is, at the new speed.
    if (this.countIn)
      this.countIn = {
        ...this.countIn,
        from: this.countInPosition(now),
        anchor: now,
      };
    this.transport.setSpeed(speed, now);
    this.settings.speed = speed;
    // Sounding notes ring on; only notes that have not started change speed.
    if (this.transport.playing) {
      this.audio.reschedule(this.transport);
      this.metronome.reschedule(now);
      // Notes held at a Wait gate keep waiting.
      if (this.transport.held) this.audio.hold();
    } else if (this.countIn) this.metronome.reschedule(now);
    else {
      this.midi.player.stop();
      this.audio.stop();
    }
    this.persist();
    this.emit();
  }
  /** The metronome turns on and off; playback goes on. */
  click() {
    // Turned on during playback, it counts in from here, as Play does. Play
    // also starts browser audio for the clicks when the piano plays the music.
    const recount =
      !this.settings.click &&
      this.settings.mode !== "wait" &&
      (this.playing || this.playbackPending);
    if (recount) this.pause();
    this.settings.click = !this.settings.click;
    if (!this.settings.click) {
      const now = this.audio.now();
      this.metronome.stop(now);
      // A count-in has nothing left to count: play from here at once.
      if (this.countIn) {
        this.countIn = null;
        this.transport.play(now);
      }
    }
    this.persist();
    this.emit();
    if (recount) void this.play();
  }
  names(enabled: boolean) {
    this.settings.names = enabled;
    this.persist();
    this.emit();
  }
  tolerance(value: number) {
    this.settings.tolerance = value;
    this.persist();
    this.emit();
  }
  learnerName(name: string) {
    this.settings.learnerName = name.slice(0, LEARNER_NAME_MAX);
    this.settings.learnerNameChosen = true;
    this.persist();
    this.emit();
  }
  dailyGoal(minutes: number) {
    if (!DAILY_GOAL_CHOICES.includes(minutes)) return;
    this.settings.dailyGoalMinutes = minutes;
    this.persist();
    this.emit();
  }
  sound(ambience: number) {
    const sound = normalizePianoSound({ ambience });
    this.settings.ambience = sound.ambience;
    this.audio.setSound({ ambience: sound.ambience });
    this.persist();
    this.emit();
  }
  pianoVoice(voice: PianoVoice, enabled: boolean) {
    if (this.settings.pianoVoices[voice] === enabled) return;
    // A voice turned on mid-passage needs its recordings, and a passage still
    // loading should not wait for those of one turned off. Play on from here
    // once the right ones load, as for a loop change.
    const resume =
      this.audible && (this.playbackPending || (enabled && this.playing));
    if (resume) this.pause();
    this.settings.pianoVoices = {
      ...this.settings.pianoVoices,
      [voice]: enabled,
    };
    this.audio.setSound({ voices: this.settings.pianoVoices });
    this.persist();
    this.emit();
    if (resume) void this.play();
  }
  seek(position: number) {
    // With the metronome on, playback counts in again from the new position,
    // as Play does. A start still loading or counting in starts over too.
    const recount = this.clicking && (this.playing || this.playbackPending);
    if (recount) this.pause();
    this.cancelPlaybackPreparation();
    this.midi.player.stop();
    this.audio.stop(!this.transport.playing);
    if (this.loopEnabled)
      position = Math.min(
        this.loopEnd - 0.001,
        Math.max(this.loopStart, position),
      );
    this.transport.seek(position, this.audio.now());
    this.position = this.transport.at(this.audio.now());
    this.clickFrom = this.position;
    this.restartScoring();
    this.notice = "";
    this.save();
    this.emit();
    if (recount) void this.play();
  }
  pause() {
    this.midiRouted = false;
    this.cancelPlaybackPreparation();
    const now = this.audio.now();
    if (this.transport.playing) this.tick(now);
    this.lastPracticeTick = null;
    this.transport.pause(now);
    this.position = this.transport.position;
    this.midi.player.stop();
    this.audio.stop();
    // After the last tick, which can schedule a click ahead.
    this.metronome.stop(now);
    this.save();
    this.emit();
  }
  /**
   * The song's sustain pedal. The laptop's optional voices follow it, and a
   * MIDI output receives it as CC64.
   */
  private get pedals(): readonly PedalSpan[] {
    return this.song.pedals ?? NO_PEDALS;
  }
  /** With `pedals`, `notes` are a passage to play, with its optional voices. */
  private async prepareAudio(
    notes: Pick<Song["notes"][number], "pitch" | "velocity">[],
    generation: number,
    pedals?: readonly PedalSpan[],
  ) {
    await this.audio.unlock();
    if (generation !== this.playGeneration || !notes.length) return;
    const controller = new AbortController();
    this.audioPreparations.add(controller);
    const preparation = this.audio.prepare(notes, controller.signal, pedals);
    this.emit();
    try {
      await preparation;
    } finally {
      this.audioPreparations.delete(controller);
      this.emit();
    }
  }
  async play() {
    // followOutput() resumes playback itself once the output has settled.
    if (this.outputChanging) return;
    this.cancelPlaybackPreparation();
    const generation = this.playGeneration;
    this.playbackPending = true;
    if (!this.notes.length) {
      this.playbackPending = false;
      this.notice =
        this.settings.left || this.settings.right
          ? "Assign at least one track to an enabled hand below."
          : "Turn on Left, Right, or both hands to play.";
      this.emit();
      return;
    }
    this.narration?.stop();
    try {
      const p = this.position;
      // A MIDI output plays it all, so the laptop prepares nothing.
      const routed = this.midi.player.connected,
        played = this.inPassage(this.withStudent(this.duetNotes)),
        laptop = routed ? NO_NOTES : played;
      this.midiRouted = routed && played.length > 0;
      this.midi.player.stop();
      this.audio.stop();
      // Browser audio is not needed for the music then, and may be
      // unavailable. The metronome still clicks on the laptop, if it can.
      let clickable = true;
      if (!routed) await this.prepareAudio(laptop, generation, this.pedals);
      else if (this.clicking)
        await this.audio.unlock().catch(() => {
          // The music plays on the piano at once, without a silent count-in.
          this.audio.error = "";
          clickable = false;
        });
      if (generation !== this.playGeneration) return;
      // Nothing waits from here on. The seeks below are this start's own,
      // so they must not count in and start again.
      this.playbackPending = false;
      this.scoringEpoch = this.audio.now();
      this.transport.seek(p, this.audio.now());
      if (p >= this.song.duration)
        this.seek(this.loopEnabled ? this.loopStart : 0);
      if (
        this.loopEnabled &&
        (this.position < this.loopStart || this.position >= this.loopEnd)
      )
        this.seek(this.loopStart);
      this.audio.setPlaybackNotes(laptop, this.pedals);
      const now = this.audio.now();
      if (this.clicking && clickable) {
        // A bar's count-in first. tick() starts playback where it ends.
        this.clickFrom = this.clicks.countIn(this.position);
        this.countIn = {
          from: this.clickFrom,
          to: this.position,
          anchor: now + COUNT_IN_DELAY,
        };
      } else {
        this.clickFrom = this.position;
        this.transport.play(now);
      }
      this.progress.attempts++;
      this.notice = "";
      this.save();
      this.emit();
    } catch {
      if (generation !== this.playGeneration) return;
      this.notice =
        this.audio.error ||
        "Browser audio could not start. Enable audio for this page and try Play again.";
      this.emit();
    } finally {
      if (generation === this.playGeneration) this.playbackPending = false;
    }
  }
  syncLoop() {
    if (this.loopEnabled && this.loopEnd > this.loopStart + 0.1)
      this.transport.loop = [this.loopStart, this.loopEnd];
    else this.transport.loop = null;
  }
  loop(enabled: boolean) {
    // The new scope may need recordings that the previous loop did not load.
    const resume = this.playing || this.playbackPending;
    if (resume) this.pause();
    this.loopEnabled = enabled;
    this.syncLoop();
    this.seek(enabled ? this.loopStart : this.position);
    if (resume) void this.play();
  }
  bounds(start: number, end: number) {
    const resume = this.loopEnabled && (this.playing || this.playbackPending);
    if (resume) this.pause();
    this.loopStart = Math.max(0, Math.min(this.song.duration - 0.2, start));
    this.loopEnd = Math.max(
      this.loopStart + 0.2,
      Math.min(this.song.duration, end),
    );
    this.syncLoop();
    // An enabled loop restarts from its new start. A disabled one does not
    // change playback, so sounding notes must not be stopped and re-struck.
    if (this.loopEnabled) this.seek(this.loopStart);
    this.save();
    this.emit();
    if (resume) void this.play();
  }
  /** Where a count-in has reached, in song time: before 0 for the song's start. */
  private countInPosition(now: number) {
    const { from, anchor } = this.countIn!;
    return from + (now - anchor) * this.transport.speed;
  }
  /** Sound the metronome's clicks up to `clock`, if it is on. */
  private clickTick(clock: ClickClock, now: number) {
    if (!this.clicking) return;
    this.metronome.tick(this.clicks, clock, now, this.audio.context);
  }
  /** Count in, and once the count reaches the play position, play from there. */
  private countInTick(now: number) {
    const countIn = this.countIn!,
      start =
        countIn.anchor + (countIn.to - countIn.from) / this.transport.speed;
    if (now >= start) {
      this.countIn = null;
      // From the moment the count ended, so the beat carries on in time.
      this.transport.play(start);
      return;
    }
    this.clickTick(
      {
        position: this.countInPosition(now),
        speed: this.transport.speed,
        pass: this.transport.cycle,
        start: countIn.from,
        loop: this.transport.loop,
      },
      now,
    );
  }
  tick(now = this.audio.now()) {
    if (this.countIn) this.countInTick(now);
    const playing = this.transport.playing,
      cycle = this.transport.cycle,
      held = this.transport.held;
    if (playing) {
      this.position = this.transport.update(now, this.waitGate);
      if (cycle !== this.transport.cycle) {
        this.passEpoch =
          now - (this.position - this.loopStart) / this.settings.speed;
        this.input.clear();
        this.practice.wrap();
        // Replay this pass from its actual clock boundary so a late callback
        // records the first Wait hold at its true arrival time.
        this.transport.seek(this.loopStart, this.passEpoch);
        this.position = this.transport.update(now, this.waitGate);
        this.clickFrom = this.loopStart;
      }
      // The duet's sounding notes wait at a gate with the learner.
      if (this.transport.held && !held && this.duetNotes.length)
        this.audio.hold();
      // Practice time counts while someone plays along: not in Listen, and
      // not once the keys have been quiet for a while, such as a Wait gate
      // left waiting. Each playback run needs its own key press, so one from
      // before a pause or the song's end cannot count the next run's start.
      if (this.lastPracticeTick === null) this.lastKeyAt = -Infinity;
      else if (
        this.settings.mode !== "listen" &&
        now - this.lastKeyAt <= IDLE_SECONDS
      )
        this.practiceLog.add(
          Math.min(now - this.lastPracticeTick, 1),
          this.song.id,
        );
      this.lastPracticeTick = this.transport.playing ? now : null;
      if (this.settings.mode === "rhythm")
        this.practice.expire(
          this.position,
          this.settings.tolerance,
          this.settings.speed,
        );
      this.scheduleAudio();
      this.clickTick(
        {
          position: this.position,
          speed: this.transport.speed,
          pass: this.transport.cycle,
          start: this.clickFrom,
          loop: this.transport.loop,
        },
        now,
      );
      if (this.audio.error) this.notice = this.audio.error;
      const total = this.practice.notes.filter(
        (n) => n.start >= this.practice.from - 0.001,
      ).length;
      if (total)
        this.progress.best = Math.max(
          this.progress.best,
          Math.round((this.practice.hit.size / total) * 100),
        );
      if (!this.transport.playing) {
        // The transport has finished, but the final piano release can still
        // be ringing. Explicit pause/seek/song changes continue to stop audio.
        this.midi.player.stop();
        this.audio.setPlaybackNotes([]);
        this.notice = "";
        this.save();
      }
      if (now - this.lastSave > 1) {
        this.save();
        this.lastSave = now;
      }
      this.emit();
    }
  }
  /**
   * Schedule what sounds next: the student part in Listen, and the duet, on
   * the MIDI output if there is one and otherwise on the laptop. In Wait mode
   * the duet waits too: its notes from the next gate on sound once the
   * student plays that gate.
   */
  private scheduleAudio() {
    const gate = this.waitGate,
      notes = this.withStudent(
        gate === undefined
          ? this.duetNotes
          : this.duetNotes.filter((note) => note.start < gate - 0.001),
      );
    if (this.midi.player.connected) {
      this.midi.player.schedule(
        notes,
        this.position,
        this.transport.cycle,
        this.transport.held,
        this.pedals,
      );
      return;
    }
    // A Wait loop's next pass is scheduled ahead, before its gates come
    // back, so it starts only the duet notes before its first gate.
    const first =
        this.settings.mode === "wait" && this.transport.loop
          ? this.practice.groups[0]?.start
          : undefined,
      next =
        first === undefined
          ? notes
          : this.duetNotes.filter((note) => note.start < first - 0.001);
    this.audio.schedule(notes, this.transport, this.pedals, next);
  }
  receive(data: Uint8Array, timestamp: number) {
    // System real-time messages (clock, active sensing) can arrive dozens of
    // times a second and never change keys, pedals or scoring.
    if (data[0] >= 0xf8) return;
    const wasPlaying = this.transport.playing,
      now = this.audio.now(),
      event = Math.min(now, this.audio.eventTime(timestamp)),
      mapped = this.transport.eventAt(event);
    if (wasPlaying) this.tick();
    const before = this.input.down;
    const edge = this.input.message(data);
    if (this.keyListeners.size) {
      // The key's own time, not when this message was handled: messages can
      // queue behind a busy page and arrive together.
      const time = Math.min(timestamp, performance.now());
      if (edge) for (const l of this.keyListeners) l(edge.pitch, true, time);
      for (const pitch of before)
        if (!this.input.down.has(pitch))
          for (const l of this.keyListeners) l(pitch, false, time);
    }
    if (edge) {
      this.lastVelocity = edge.velocity;
      // Only presses during playback that counts keep practice time going;
      // one made while paused or in Listen would credit idle time after. The
      // press's own time counts, not a late delivery's.
      if (
        wasPlaying &&
        this.settings.mode !== "listen" &&
        event >= this.scoringEpoch
      )
        this.lastKeyAt = Math.max(this.lastKeyAt, event);
      // A Rhythm press within the timing window before a loop wrap, delivered
      // after it, is scored in the new pass's time. There it can be early for
      // the pass's first notes or late for the previous pass's last ones.
      const carried =
        this.settings.mode === "rhythm" &&
        event < this.passEpoch &&
        this.passEpoch - event <= this.settings.tolerance + TIMING_EPSILON;
      if (
        wasPlaying &&
        event >= this.scoringEpoch &&
        (event >= this.passEpoch || carried)
      ) {
        // Wait gates are recorded by tick; map again so delayed events retain
        // their actual position, including time spent held at the gate.
        const position =
          this.settings.mode === "wait"
            ? this.transport.eventAt(event).position
            : mapped.position - (carried ? this.loopEnd - this.loopStart : 0);
        const advanced = this.practice.input(
          edge.pitch,
          position,
          this.settings.mode,
          this.settings.tolerance,
          mapped.speed,
          this.input.down,
        );
        if (advanced) {
          this.transport.resume(this.position, now);
          this.notice = "";
          if (this.duetNotes.length) {
            // Held duet notes end where they are written from here, and its
            // notes at this gate sound with the student's key.
            this.audio.reschedule(this.transport);
            this.scheduleAudio();
          }
        }
      } else if (this.countIn && this.settings.mode === "rhythm") {
        // A press as the count-in ends can be early for the first notes. In
        // song time it falls that far before the play position.
        const { from, to, anchor } = this.countIn,
          speed = this.transport.speed,
          early = anchor + (to - from) / speed - event;
        if (
          event >= this.scoringEpoch &&
          early <= this.settings.tolerance + TIMING_EPSILON
        )
          this.practice.input(
            edge.pitch,
            to - early * speed,
            "rhythm",
            this.settings.tolerance,
            speed,
            this.input.down,
          );
      }
    }
    this.emit();
  }
  /**
   * Let go of every key, as when the window loses focus and key-ups can no
   * longer arrive. Keys held on screen or on the computer keyboard stop
   * sounding on a MIDI output.
   */
  releaseKeys() {
    const down = [...this.input.down],
      time = performance.now();
    for (const pitch of down) this.midi.player.keyUp(pitch);
    this.input.clear();
    // Followers of the keys hear them come up, as the keys can no longer,
    // marked as lost rather than let go.
    for (const pitch of down)
      for (const listener of this.keyListeners)
        listener(pitch, false, time, true);
  }
  virtual(pitch: number, on: boolean) {
    const request = ++this.nextVirtualRequest;
    if (on) this.virtualRequests.set(pitch, request);
    else this.virtualRequests.delete(pitch);
    this.receive(
      new Uint8Array([on ? 0x9f : 0x8f, pitch, on ? 90 : 0]),
      performance.now(),
    );
    // While the output changes the key still counts, but makes no sound: it
    // could only go to the output that is on its way out.
    if (this.outputChanging) return;
    // A MIDI output sounds the key on the piano for as long as it is held.
    if (this.midi.player.connected) {
      if (on) this.midi.player.keyDown(pitch, KEY_VELOCITY);
      else this.midi.player.keyUp(pitch);
      return;
    }
    if (on) {
      const generation = this.playGeneration;
      void this.prepareAudio([{ pitch, velocity: KEY_VELOCITY }], generation)
        .then(() => {
          if (
            generation === this.playGeneration &&
            this.virtualRequests.get(pitch) === request &&
            this.input.down.has(pitch)
          )
            this.audio.tone(pitch, KEY_VELOCITY, this.audio.now(), 0.4);
        })
        .catch(() => {
          if (generation !== this.playGeneration) return;
          this.notice = this.audio.error || SOUND_UNAVAILABLE;
          this.emit();
        });
    }
  }
}
