import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { draw, pianoKeyAt } from "./render";
import { watchCanvasRedraws } from "./canvasRedraw";
import { saveReloadSnapshot } from "./reloadSnapshot";
import { noteName, type Hand, type Song } from "./song";
import { SPEED_PERCENT, type Feedback, type Mode } from "./engine";
import { FingerGuide } from "./FingerGuide";
import { SongLibrary } from "./SongLibrary";
import { PianoSoundControls } from "./PianoSoundControls";
import type { PianoVoice } from "./pianoSound";
import { SheetTimeline } from "./SheetTimeline";
import { LoopBoundInput } from "./LoopBoundInput";
import { describeWaitTarget } from "./waitTarget";
import { usePianoFullscreen } from "./usePianoFullscreen";
import { usePracticeShortcuts } from "./usePracticeShortcuts";
import { bookForSong, songsInBook } from "./books";
import { PracticeCalendar, useLocalDay } from "./PracticeCalendar";
import { cloud, currentUser, studio } from "./session";
import { CD_AUDIO_BUCKET, StoryPlayer } from "./story";
import { signedInFetch } from "./supabase";
import { SongTitle } from "./SongTitle";
import { Workbook } from "./WorkbookScreen";
import { ANSWER_KEYS, WORKBOOK_PAGES, readStamps, stampPage } from "./workbook";
/**
 * Save a library song's MIDI file. Only a signed-in request can read it, so
 * a plain link cannot: fetch it, then save it from this page.
 */
async function downloadMidi(song: Song) {
  const midi = song.library?.midi;
  if (!midi) return;
  try {
    const response = await (await signedInFetch())(midi);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = `${song.id}.mid`;
    link.click();
    // The browser has the file once the save starts.
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  } catch {
    studio.notice = `${song.title} could not be downloaded. Check your connection and try again.`;
    studio.emit();
  }
}
/** The course CD's story before each piece of Lesson Book 3. */
const story = new StoryPlayer(
  (path) =>
    `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/authenticated/${CD_AUDIO_BUCKET}/${path}`,
  signedInFetch,
);
/** Play the story before `song`. Practice pauses first: they never sound together. */
function playStory(song: Song) {
  studio.pause();
  story.play(song.id).catch(() => {
    studio.notice = `The story before ${song.title} could not be played. Check your connection and try again.`;
    studio.emit();
  });
}
const practiceDay = () => studio.practiceLog.today();
const setLearnerName = (name: string) => studio.learnerName(name);
const setDailyGoal = (minutes: number) => studio.dailyGoal(minutes);
const stamp = (t: number) =>
  `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
// The studio is a singleton, so these stay stable and let memoized views skip
// the 50 updates a second that playback makes.
const selectSong = (song: Song | undefined) => {
  if (!song) return;
  studio.save();
  studio.load(song);
};
const seek = (position: number) => studio.seek(position);
const setAmbience = (ambience: number) => studio.sound(ambience);
const setPianoVoice = (voice: PianoVoice, enabled: boolean) =>
  studio.pianoVoice(voice, enabled);

/** On a workbook page, the answer keys and the control keys. */
const ANSWER_SHORTCUTS: Record<string, number> = {
  l: ANSWER_KEYS[0],
  ";": ANSWER_KEYS[1],
  "'": ANSWER_KEYS[2],
  // The control keys C2, D2, E2 and F2.
  "1": 36,
  "2": 38,
  "3": 40,
  "4": 41,
};
const shortcuts: Record<string, number> = {
  z: 48,
  x: 50,
  c: 52,
  v: 53,
  b: 55,
  n: 57,
  m: 59,
  a: 60,
  w: 61,
  s: 62,
  e: 63,
  d: 64,
  f: 65,
  t: 66,
  g: 67,
  y: 68,
  h: 69,
  u: 70,
  j: 71,
  k: 72,
};
const Piano = memo(function Piano() {
  const canvas = useRef<HTMLCanvasElement>(null),
    pointers = useRef(new Map<number, number>());
  // Paint before the first frame shows, so the piano never appears blank.
  useLayoutEffect(() => {
    const element = canvas.current!;
    return watchCanvasRedraws(element, studio.subscribe, () =>
      draw(element, {
        song: studio.song,
        notes: studio.notes,
        position: studio.position,
        input: studio.input,
        practice: studio.practice,
        names: studio.settings.names,
        waiting: studio.settings.mode === "wait" && studio.transport.playing,
        listen: studio.settings.mode === "listen",
        duet: studio.duetNotes,
      }),
    );
  }, []);
  const press = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect(),
      x = (e.clientX - rect.left) / rect.width,
      y = e.clientY - rect.top;
    const pitch = pianoKeyAt(studio.song, x, y, rect.height);
    if (pitch !== undefined) {
      e.currentTarget.setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, pitch);
      studio.virtual(pitch, true);
    }
  };
  const release = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointers.current.get(e.pointerId);
    if (p !== undefined) {
      studio.virtual(p, false);
      pointers.current.delete(e.pointerId);
    }
  };
  return (
    <canvas
      ref={canvas}
      className="piano"
      role="img"
      aria-label="Piano waterfall aligned to keyboard. Lavender: right hand. Teal: left hand. Use your MIDI piano, computer shortcuts, or the on-screen keyboard."
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
    />
  );
});
/**
 * Play or stop the CD's story that leads into a piece of Lesson Book 3, once
 * the CD's manifest says the piece has one.
 */
const StoryButton = memo(function StoryButton({ song }: { song: Song }) {
  useSyncExternalStore(story.subscribe, story.snapshot);
  const lesson = song.library?.book === "lesson-3";
  // The manifest loads with the first piece of Lesson Book 3 shown.
  useEffect(() => {
    if (lesson) story.load();
  }, [lesson, song.id]);
  if (!story.has(song.id)) return null;
  const playing = story.playing === song.id;
  return (
    <button
      type="button"
      className="song-story"
      aria-pressed={playing}
      aria-label={playing ? "Stop story" : "Play story"}
      title="The story from the CD that leads into this piece"
      // A click leaves the focus where it was, so Space and Enter go on
      // controlling practice rather than this button.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (playing ? story.stop() : playStory(song))}
    >
      <span aria-hidden="true">{playing ? "■" : "▷"}</span>{" "}
      {playing ? "Stop story" : "Story"}
    </button>
  );
});
/** Where the mode switcher's highlight sits, measured from the active button. */
function useActiveIndicator(
  group: React.RefObject<HTMLElement | null>,
  active: string,
) {
  const [indicator, setIndicator] = useState<{ left: number; width: number }>();
  useLayoutEffect(() => {
    const element = group.current;
    if (!element) return;
    const measure = () => {
      const button = element.querySelector<HTMLElement>(
        '[aria-pressed="true"]',
      );
      if (button)
        setIndicator({ left: button.offsetLeft, width: button.offsetWidth });
    };
    measure();
    // Labels change width when fonts load or the layout wraps.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [group, active]);
  return indicator;
}
const PracticeControls = memo(function PracticeControls({
  mode,
  left,
  right,
  duet,
  hasDuet,
}: {
  mode: Mode;
  left: boolean;
  right: boolean;
  duet: boolean;
  hasDuet: boolean;
}) {
  const tabs = useRef<HTMLDivElement>(null);
  const indicator = useActiveIndicator(tabs, mode);
  return (
    <div className="toolbar-preferences">
      <div
        ref={tabs}
        className={`tabs${indicator ? " has-indicator" : ""}`}
        role="group"
        aria-label="Practice mode"
      >
        {indicator && (
          <span
            className="tabs-indicator"
            aria-hidden="true"
            style={{
              transform: `translateX(${indicator.left}px)`,
              width: indicator.width,
            }}
          />
        )}
        {(["listen", "wait", "rhythm"] as const).map((option) => (
          <button
            key={option}
            aria-pressed={mode === option}
            onClick={() => studio.mode(option)}
          >
            {option === "wait"
              ? "Wait for me"
              : option === "listen"
                ? "Listen"
                : "Rhythm"}
          </button>
        ))}
      </div>
      <div className="hands" role="group" aria-label="Practice hands">
        {(["left", "right"] as const).map((hand) => (
          <button
            key={hand}
            aria-pressed={hand === "left" ? left : right}
            onClick={() => studio.hand(hand)}
          >
            <span className={`swatch ${hand}`} />
            {hand === "left" ? "Left" : "Right"}
          </button>
        ))}
        <button
          aria-pressed={duet && hasDuet}
          disabled={!hasDuet}
          title={
            hasDuet
              ? "Teacher duet plays along. Your piano is never scored on it."
              : "This song has no duet part"
          }
          onClick={() => studio.duet()}
        >
          <span className="swatch duet" />
          Duet
        </button>
      </div>
    </div>
  );
});
const PassagePanel = memo(function PassagePanel({
  song,
  loopStart,
  loopEnd,
}: {
  song: Song;
  loopStart: number;
  loopEnd: number;
}) {
  return (
    <section className="panel" aria-label="Tracks and passage">
      <div className="panel-heading">
        Make it yours <span>Tracks & passage</span>
      </div>
      <div className="assignments">
        {song.tracks
          .filter((t) => t.count)
          .map((track) => (
            <label key={track.id}>
              <span>
                {track.name}
                <small>{track.count} notes</small>
              </span>
              <select
                aria-label={`Hand for ${track.name}`}
                value={track.hand}
                onChange={(e) =>
                  studio.assign(track.id, e.target.value as Hand)
                }
              >
                <option value="off">Skip</option>
                <option value="left">Left hand</option>
                <option value="right">Right hand</option>
              </select>
            </label>
          ))}
      </div>
      <p className="small">
        Choose hands explicitly. Track names are only suggestions. A single
        track can be assigned to one hand.
      </p>
      <div className="loop-fields">
        <label>
          From{" "}
          <LoopBoundInput
            key={song.id}
            label="Loop start seconds"
            value={loopStart}
            min={0}
            max={loopEnd - 0.2}
            onCommit={(start) => studio.bounds(start, studio.loopEnd)}
          />
          <span>s</span>
        </label>
        <button
          title="Set loop start to current position"
          onClick={() => studio.bounds(studio.position, studio.loopEnd)}
        >
          Set A
        </button>
        <label>
          To{" "}
          <LoopBoundInput
            key={song.id}
            label="Loop end seconds"
            value={loopEnd}
            min={loopStart + 0.2}
            max={song.duration}
            onCommit={(end) => studio.bounds(studio.loopStart, end)}
          />
          <span>s</span>
        </label>
        <button
          title="Set loop end to current position"
          onClick={() => studio.bounds(studio.loopStart, studio.position)}
        >
          Set B
        </button>
      </div>
      {song.warnings.map((w) => (
        <p className="small" key={w}>
          {w}
        </p>
      ))}
    </section>
  );
});
// `misses` grows in place, but always together with a new `recent` item.
const PracticeReview = memo(function PracticeReview({
  recent,
  misses,
  matched,
  missed,
  wrong,
  timing,
  attempts,
  best,
}: {
  recent: Feedback | undefined;
  misses: readonly Feedback[];
  matched: number;
  missed: number;
  wrong: number;
  timing: number | undefined;
  attempts: number;
  best: number;
}) {
  return (
    <section className="panel feedback" aria-label="Practice review">
      <div className="panel-heading">
        A little better each time <span>Practice review</span>
      </div>
      <div className="stats">
        <div>
          <strong>{matched}</strong>
          <span>Matched</span>
        </div>
        <div>
          <strong>{missed}</strong>
          <span>Missed</span>
        </div>
        <div>
          <strong>{timing === undefined ? "—" : timing + " ms"}</strong>
          <span>Average timing error</span>
        </div>
      </div>
      <p className="small">
        {recent
          ? recent.kind === "wrong"
            ? `Try the highlighted notes. ${noteName(recent.pitch)} wasn’t in the timing window.`
            : recent.kind === "miss"
              ? `Missed ${noteName(recent.pitch)} at ${stamp(recent.at)}.`
              : recent.kind === "hit"
                ? "That’s it. Keep going."
                : `Matched ${noteName(recent.pitch)} · ${Math.abs(Math.round((recent.offset || 0) * 1000))} ms ${recent.kind}, within tolerance.`
          : "Your note and timing feedback will appear here. Wait for me checks notes; Rhythm adds timing."}
      </p>
      {misses.length > 0 && (
        <div className="misses">
          {misses.map((m, i) => (
            <button
              key={i}
              title="Replay around this missed note"
              onClick={() => {
                studio.bounds(
                  Math.max(0, m.at - 1),
                  Math.min(studio.song.duration, m.at + 2),
                );
                studio.loop(true);
              }}
            >
              {noteName(m.pitch)} · {stamp(m.at)} ↺
            </button>
          ))}
        </div>
      )}
      <div className="progress-note">
        {wrong} wrong presses · {attempts} starts saved · Best matched {best}%
        <span>Skipped notes are excluded after seeking.</span>
      </div>
    </section>
  );
});
const KeyboardHelp = memo(function KeyboardHelp({
  shift,
}: {
  /** Semitones the keys move with the student part, as with Duet on. */
  shift: number;
}) {
  const [showKeys, setShowKeys] = useState(false);
  return (
    <details
      className="keyboard-help"
      onToggle={(e) => setShowKeys(e.currentTarget.open)}
    >
      <summary>
        Try the on-screen keys <span>or use your computer keyboard</span>
      </summary>
      <p>
        Left hand: Z X C V B N M · Right hand: A W S E D F T G Y H U J K. You
        can also click the piano keys. These are practice inputs; your USB piano
        supplies its own live sound. A teal dot marks sound held by the pedal
        after key release.
      </p>
      {showKeys && (
        <div className="accessible-keys">
          {Object.entries(shortcuts).map(([key, written]) => {
            const pitch = written + shift;
            return (
              <button
                key={key}
                aria-label={`Play ${noteName(pitch)}`}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  studio.virtual(pitch, true);
                }}
                onPointerUp={() => studio.virtual(pitch, false)}
                onPointerCancel={() => studio.virtual(pitch, false)}
                onLostPointerCapture={() => studio.virtual(pitch, false)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
                    e.preventDefault();
                    studio.virtual(pitch, true);
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    studio.virtual(pitch, false);
                }}
              >
                {noteName(pitch)}
                <small>{key.toUpperCase()}</small>
              </button>
            );
          })}
        </div>
      )}
    </details>
  );
});
export function App({
  email,
  onSignOut,
}: {
  email: string;
  onSignOut: () => void;
}) {
  useSyncExternalStore(studio.subscribe, studio.snapshot);
  const [connectTried, setConnectTried] = useState(false),
    [busy, setBusy] = useState(false);
  // The open Music Workbook 3 page, which takes the studio's place.
  const [workbookPage, setWorkbookPage] = useState<number | null>(null),
    [stamps, setStamps] = useState(readStamps);
  const openPage = useCallback((page: number) => {
    // The workbook and the song never sound together.
    studio.pause();
    story.stop();
    // Start the laptop's sound while the click still counts as a gesture:
    // Hold It!'s clicks and Ear's examples play later, from timers and
    // piano keys, which do not.
    void studio.audio.unlock().catch(() => {});
    setWorkbookPage(page);
  }, []);
  const chooseSong = useCallback((song: Song) => {
    setWorkbookPage(null);
    selectSong(song);
  }, []);
  const finishPage = useCallback((page: number) => {
    const { stamps, saved } = stampPage(page);
    // Unsaved stamps from earlier in this session stay too.
    setStamps((current) => ({ ...current, ...stamps }));
    if (!saved) {
      studio.storageNotice =
        "Browser storage is full or blocked. Workbook stamps will last for this session.";
      studio.emit();
    }
  }, []);
  const leaveWorkbook = useCallback(() => setWorkbookPage(null), []);
  const workbook = useMemo(
    () => ({
      pages: WORKBOOK_PAGES,
      selected: workbookPage,
      stamps,
      onSelect: openPage,
    }),
    [workbookPage, stamps, openPage],
  );
  const page = WORKBOOK_PAGES.find((p) => p.page === workbookPage);
  // A workbook page's notes are fixed, so the computer keys play them
  // unshifted even when the song behind it has Duet moving its part.
  const pageOpen = useRef(false);
  useEffect(() => {
    pageOpen.current = !!page;
  }, [page]);
  const fullscreen = usePianoFullscreen(() => {
    if (!studio.playing && !busy) void startPlayback();
  });
  const s = studio.settings,
    p = studio.practice,
    playing = studio.playing;
  const connected = studio.midi.status === "connected",
    connecting = studio.midi.status === "opening",
    selectedDevice = studio.midi.devices.find(
      (d) => d.id === studio.midi.selectedId,
    );
  const book = bookForSong(studio.song);
  const bookSongs = songsInBook(studio.songs, book.id);
  const songIndex = bookSongs.findIndex((song) => song.id === studio.song.id);
  const previousSong = bookSongs[songIndex - 1];
  const nextSong = bookSongs[songIndex + 1];
  useEffect(() => {
    studio.init();
    studio.narration = story;
    const shift = () => (pageOpen.current ? 0 : studio.octaveShift);
    // The pitch each computer key pressed, so its release lets go of that
    // pitch even if the shift changed meanwhile (a workbook page opened).
    const held = new Map<string, number>();
    const down = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).closest(
          "input,select,textarea,[contenteditable=true]",
        ) ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.repeat
      )
        return;
      const key = e.key.toLowerCase(),
        // On a workbook page L ; and ', the keys after the play zone's K,
        // are the answer keys G5, A5 and B5, and 1 to 4 the control keys.
        written =
          shortcuts[key] ??
          (pageOpen.current ? ANSWER_SHORTCUTS[key] : undefined);
      if (written !== undefined) {
        e.preventDefault();
        // With Duet on, the keys follow the student part up.
        const pitch = written + shift();
        held.set(key, pitch);
        studio.virtual(pitch, true);
      }
    };
    const up = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase(),
        pitch = held.get(key);
      held.delete(key);
      if (pitch !== undefined && studio.input.down.has(pitch)) {
        studio.virtual(pitch, false);
      }
    };
    const blur = () => {
      held.clear();
      studio.releaseKeys();
      if (studio.playing && studio.settings.mode !== "listen") studio.pause();
      else studio.emit();
    };
    const hidden = () => {
      if (document.hidden) studio.pause();
    };
    const save = () => {
      // Also cancel starts still opening audio/MIDI, and release hardware notes.
      studio.pause();
      saveReloadSnapshot(document.getElementById("root")!, currentUser ?? "");
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      studio.destroy();
      studio.narration = null;
      story.dispose();
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  // Full screen is for practice.
  useEffect(() => {
    if (fullscreen.expanded) story.stop();
  }, [fullscreen.expanded]);
  const stageNotice = studio.audio.loading
    ? "Loading grand piano sound…"
    : studio.notice;
  const startPlayback = async () => {
    setBusy(true);
    try {
      await studio.play();
    } finally {
      setBusy(false);
    }
  };
  const toggle = async () => {
    if (busy) return;
    if (studio.playing) studio.pause();
    else await startPlayback();
  };
  const navigateSong = async (song: Song | undefined) => {
    if (!song || busy) return;
    selectSong(song);
    await startPlayback();
  };
  usePracticeShortcuts({
    enabled: !page,
    busy,
    onEnter: () => void fullscreen.enter(),
    onTogglePlayback: () => void toggle(),
    onPreviousSong: () => void navigateSong(previousSong),
    onNextSong: () => void navigateSong(nextSong),
  });
  const misses = p.recentMisses,
    stats = p.stats,
    recent = p.feedback.at(-1);
  const today = useLocalDay(practiceDay);
  // Totals change at most once a second, when a day gains a whole second.
  const practiceRevision = studio.practiceLog.revision;
  const practiceTotals = useMemo(
    () => studio.practiceLog.totals(),
    [practiceRevision, today],
  );
  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="./" aria-label="Paw Pal home">
          <img
            className="brand-mark"
            src={`${import.meta.env.BASE_URL}bearpaws.svg?v=3`}
            alt=""
            width="40"
            height="40"
          />
          <span className="brand-name" aria-hidden="true">
            <span className="brand-initial">P</span>aw{" "}
            <span className="brand-initial">P</span>al
          </span>
        </a>
        <span className="eyebrow">A little practice. Every day.</span>
        <div className="device-group">
          {/* Several inputs (a piano plus a controller or virtual port) need a choice. */}
          {studio.midi.devices.length > 1 && (
            <select
              aria-label="MIDI input device"
              value={studio.midi.selectedId}
              onChange={(e) => studio.midi.select(e.target.value)}
            >
              {!selectedDevice && (
                <option value={studio.midi.selectedId}>
                  Disconnected input
                </option>
              )}
              {studio.midi.devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          {connected ? (
            <span className="device" title={selectedDevice?.name}>
              <span className="dot connected" />
              Piano connected
            </span>
          ) : (
            <button
              className="device"
              disabled={connecting}
              onClick={() => {
                setConnectTried(true);
                void studio.midi.connect();
              }}
            >
              <span className="dot" />
              {connecting ? "Connecting…" : "Connect your piano"}
            </button>
          )}
        </div>
        {/* The piano's output is chosen as it connects. Keep the choice, and
            retry, available without an input. */}
        {(connected ||
          studio.midi.outputs.length > 0 ||
          studio.midi.selectedOutputId) && (
          <label>
            Sound
            <select
              aria-label="Sound"
              disabled={studio.outputChanging}
              value={studio.midi.selectedOutputId}
              onChange={(e) => void studio.soundOutput(e.target.value)}
            >
              <option value="">Laptop</option>
              {studio.midi.outputs.map((port) => (
                <option key={port.id} value={port.id}>
                  {port.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="account"
          title={email ? `Signed in as ${email}` : undefined}
          onClick={onSignOut}
        >
          Sign out
        </button>
      </header>
      <p className="sr-only" role="status">
        {studio.midi.message}
      </p>
      {studio.midi.outputMessage && (
        <p className="connection" role="status">
          {studio.midi.outputMessage}
        </p>
      )}
      {/* After a click, say why the piano is not connected yet. */}
      {connectTried && !connected && !connecting && (
        <p className="connection">{studio.midi.message}</p>
      )}
      <div className="body">
        <aside className="sidebar">
          <PracticeCalendar
            totals={practiceTotals}
            today={today}
            learnerName={s.learnerName}
            goalMinutes={s.dailyGoalMinutes}
            onLearnerName={setLearnerName}
            onGoalMinutes={setDailyGoal}
          />
          <SongLibrary
            songs={studio.songs}
            selected={page ? "" : studio.song.id}
            onSelect={chooseSong}
            workbook={workbook}
          />
          <p className="privacy">Progress syncs to your account.</p>
          <div className="side-footer">
            <strong>One phrase at a time.</strong>Slow it down.
            <br />
            Find your rhythm.
          </div>
        </aside>
        <main>
          {page ? (
            <Workbook
              key={page.page}
              page={page}
              stamp={stamps[page.page]}
              onFinish={finishPage}
              onPage={openPage}
              onLeave={leaveWorkbook}
              notice={studio.storageNotice}
              syncError={cloud?.error}
            />
          ) : (
            <>
              <div className="song-head">
                <div>
                  <div className="kicker">Practice studio</div>
                  <h1>
                    <SongTitle title={studio.song.title} />
                  </h1>
                  <p>
                    {studio.song.source ? (
                      <>
                        {studio.song.source.composer} ·{" "}
                        {studio.song.source.description}{" "}
                        {studio.song.source.url ? (
                          <a
                            href={studio.song.source.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            MIDI by {studio.song.source.credit}
                          </a>
                        ) : (
                          studio.song.source.credit
                        )}
                      </>
                    ) : studio.song.lesson ? (
                      `${studio.song.lesson.composer} · ${studio.song.lesson.description}`
                    ) : (
                      `${studio.song.tracks.filter((t) => t.count).length} note tracks · ${studio.song.tempos.length || 1} tempo events`
                    )}
                  </p>
                </div>
                <div className="song-tools">
                  <span className="chip">{book.title}</span>
                  <StoryButton song={studio.song} />
                  {studio.song.library?.midi && (
                    <button
                      type="button"
                      className="song-midi-download"
                      onClick={() => void downloadMidi(studio.song)}
                      aria-label={`Download ${studio.song.title} MIDI`}
                    >
                      Download MIDI
                    </button>
                  )}
                </div>
              </div>
              {studio.storageNotice && (
                <p className="alert" role="status">
                  {studio.storageNotice}
                </p>
              )}
              {cloud?.error && (
                <p className="alert" role="status">
                  {cloud.error}
                </p>
              )}
              <FingerGuide song={studio.song} left={s.left} right={s.right} />
              <div className="workspace">
                <div
                  id="piano-stage"
                  ref={fullscreen.stage}
                  className={`work-main ${fullscreen.expanded ? "piano-expanded" : ""}`}
                  role={fullscreen.expanded ? "dialog" : "region"}
                  aria-label="Piano practice"
                  aria-modal={fullscreen.expanded || undefined}
                  tabIndex={-1}
                >
                  <div
                    className="practice-toolbar"
                    aria-label="Practice controls"
                  >
                    {fullscreen.expanded && (
                      <div
                        className="fullscreen-song-heading"
                        title={studio.song.title}
                      >
                        <strong className="fullscreen-song-title">
                          <SongTitle title={studio.song.title} />
                        </strong>
                        <div className="fullscreen-book">
                          {book.title} · {songIndex + 1} of {bookSongs.length}
                        </div>
                      </div>
                    )}
                    <PracticeControls
                      mode={s.mode}
                      left={s.left}
                      right={s.right}
                      duet={s.duet}
                      hasDuet={!!studio.song.duet}
                    />
                    <div
                      className="transport-buttons"
                      role="group"
                      aria-label="Playback"
                    >
                      <button
                        className="square"
                        aria-label="Restart passage"
                        title="Restart passage"
                        onClick={() => studio.seek(0)}
                      >
                        ↺
                      </button>
                      <button
                        className="primary play"
                        disabled={busy || studio.outputChanging}
                        aria-busy={busy || studio.outputChanging}
                        title={playing ? "Pause (Space)" : "Play (Space)"}
                        aria-keyshortcuts="Space"
                        onClick={() => void toggle()}
                      >
                        {busy ? "Loading…" : playing ? "Ⅱ Pause" : "▷ Play"}
                      </button>
                      <button
                        className="square"
                        aria-label="Loop passage"
                        title="Loop passage"
                        aria-pressed={studio.loopEnabled}
                        onClick={() => studio.loop(!studio.loopEnabled)}
                      >
                        ⇄
                      </button>
                      <button
                        className="square metronome"
                        aria-label="Metronome"
                        title={
                          s.mode === "wait"
                            ? "No metronome in Wait for me: the music waits for you"
                            : "Metronome: a click on every beat, after a bar's count-in"
                        }
                        aria-pressed={studio.clicking}
                        disabled={s.mode === "wait"}
                        onClick={() => studio.click()}
                      >
                        <svg
                          viewBox="0 0 16 16"
                          width="16"
                          height="16"
                          aria-hidden="true"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M5.5 1.75h5l2.75 12.5H2.75z" />
                          <path d="M8 11.25l3.75-6.5" />
                        </svg>
                      </button>
                    </div>
                    <div className="playback-cluster">
                      <div
                        className="playback-status"
                        role="group"
                        aria-label="Speed and position"
                      >
                        <label className="speed">
                          <span className="speed-label">Speed</span>
                          <input
                            aria-label="Playback speed"
                            title="Playback speed"
                            type="range"
                            min={SPEED_PERCENT.min}
                            max={SPEED_PERCENT.max}
                            step={SPEED_PERCENT.step}
                            value={s.speed * 100}
                            onChange={(e) =>
                              studio.speed(Number(e.target.value) / 100)
                            }
                          />
                          <output>{Math.round(s.speed * 100)}%</output>
                        </label>
                        <span className="time">
                          {stamp(studio.position)} /{" "}
                          {stamp(studio.song.duration)}
                        </span>
                      </div>
                      <button
                        className="fullscreen-toggle"
                        aria-label={
                          fullscreen.expanded
                            ? "Exit full screen"
                            : "Full screen piano"
                        }
                        aria-expanded={fullscreen.expanded}
                        aria-controls="piano-stage"
                        aria-keyshortcuts={
                          fullscreen.expanded ? "Escape" : "Enter"
                        }
                        title={
                          fullscreen.expanded
                            ? "Exit full screen (Esc)"
                            : "Full screen and play (Enter)"
                        }
                        onClick={() => void fullscreen.toggle()}
                      >
                        <span aria-hidden="true">
                          {fullscreen.expanded ? "↙" : "⛶"}
                        </span>
                        {/* Icon only beside the controls, so they fit one row. */}
                        {fullscreen.expanded && "Exit full screen"}
                      </button>
                    </div>
                    {fullscreen.expanded && (
                      <div
                        className="song-navigation"
                        role="group"
                        aria-label="Book navigation"
                      >
                        <button
                          aria-label="Previous song"
                          aria-keyshortcuts="ArrowLeft"
                          title={
                            previousSong
                              ? `Previous: ${previousSong.title} (Left arrow)`
                              : "First song in this book"
                          }
                          disabled={!previousSong || busy}
                          onClick={() => void navigateSong(previousSong)}
                        >
                          <span aria-hidden="true">←</span> Previous
                        </button>
                        <button
                          aria-label="Next song"
                          aria-keyshortcuts="ArrowRight"
                          title={
                            nextSong
                              ? `Next: ${nextSong.title} (Right arrow)`
                              : "Last song in this book"
                          }
                          disabled={!nextSong || busy}
                          onClick={() => void navigateSong(nextSong)}
                        >
                          Next <span aria-hidden="true">→</span>
                        </button>
                      </div>
                    )}
                  </div>
                  {stageNotice && (
                    <div className="piano-notice" role="status">
                      {stageNotice}
                    </div>
                  )}
                  {studio.duetNotes.length > 0 && (
                    <p className="duet-note">
                      <span className="swatch duet" /> Duet: the teacher part
                      plays along.{" "}
                      {studio.octaveShift
                        ? `Play ${Math.abs(studio.octaveShift) > 12 ? "two octaves" : "one octave"} ${studio.octaveShift > 0 ? "higher" : "lower"}, as the book shows.`
                        : "Play as written."}
                    </p>
                  )}
                  {s.mode === "wait" && (
                    <p className="sr-only" aria-live="polite">
                      {describeWaitTarget(
                        studio.song,
                        p.gate,
                        studio.input.down,
                        p.hit,
                      )}
                    </p>
                  )}
                  <SheetTimeline
                    song={studio.written}
                    octaves={studio.octaveShift / 12}
                    position={studio.position}
                    mode={s.mode}
                    hit={p.hit}
                    selectedNotes={studio.notes}
                    from={p.from}
                    onSeek={seek}
                  />
                  <div className="roll">
                    <div className="roll-caption">
                      <span>
                        {s.mode === "listen"
                          ? "Follow the music"
                          : s.mode === "wait"
                            ? "Your pace. Your next note."
                            : "Find your rhythm"}
                      </span>
                      <div className="roll-actions">
                        <span>5 seconds ahead</span>
                      </div>
                    </div>
                    <Piano />
                  </div>
                </div>
              </div>
              <div className="settings-row">
                <label>
                  Timing tolerance{" "}
                  <select
                    aria-label="Timing tolerance"
                    value={s.tolerance}
                    onChange={(e) => studio.tolerance(Number(e.target.value))}
                  >
                    <option value="0.12">Focused · ±120 ms</option>
                    <option value="0.22">Relaxed · ±220 ms</option>
                    <option value="0.35">Gentle · ±350 ms</option>
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={s.names}
                    onChange={(e) => studio.names(e.target.checked)}
                  />{" "}
                  Note names
                </label>
                <PianoSoundControls
                  ambience={s.ambience}
                  onChange={setAmbience}
                  voices={s.pianoVoices}
                  onVoiceChange={setPianoVoice}
                />
                <span className="pedal">
                  <span>
                    Pedal <b>{studio.input.sustain ? "Down" : "Up"}</b>
                  </span>
                  <span>
                    Velocity <b>{studio.lastVelocity || "—"}</b>
                  </span>
                </span>
              </div>
              <section className="lower-grid">
                <PracticeReview
                  recent={recent}
                  misses={misses}
                  matched={p.hit.size}
                  missed={stats.missed}
                  wrong={stats.wrong}
                  timing={
                    stats.timingCount
                      ? Math.round(
                          (stats.timingAbsTotal / stats.timingCount) * 1000,
                        )
                      : undefined
                  }
                  attempts={studio.progress.attempts}
                  best={studio.progress.best}
                />
                <PassagePanel
                  song={studio.song}
                  loopStart={studio.loopStart}
                  loopEnd={studio.loopEnd}
                />
              </section>
              <KeyboardHelp shift={studio.octaveShift} />
            </>
          )}
          <footer>
            Practice syncs to your account.{" "}
            <span>USB MIDI · Desktop Chrome / Edge · HTTPS required</span>
            <span className="footer-separator" aria-hidden="true">
              ·
            </span>
            <a
              href={`${import.meta.env.BASE_URL}audio/accurate-salamander/CREDITS.md`}
            >
              Accurate-Salamander · 8 layers · sound credits
            </a>
          </footer>
        </main>
      </div>
    </div>
  );
}
