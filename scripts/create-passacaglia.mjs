// Transcription of the 22 complete measures visible in the supplied score.
// The photograph ends during A1a; this is deliberately an excerpt, not a
// reconstruction of the missing pages. Pitch names use C4 = middle C.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeMidi } from "midi-file";

const ppq = 480;
const bpm = 130;
const eighths = (notes) => notes.split(" ").map((pitch) => [pitch, 0.5]);
const cadence = () => [
  ["A5", 1],
  ["G#5", 0.5],
  ["F#5", 0.5],
  ["G#5", 1.5],
  ["A5", 0.5],
];
const right = [
  [[null, 4]],
  [[null, 4]],
  eighths("C5 C6 B5 C6 A5 C6 G5 C6"),
  eighths("F5 C6 E5 C6 D5 C6 C5 C6"),
  eighths("B4 B5 A5 B5 G5 B5 F5 B5"),
  eighths("E5 B5 D5 B5 C5 B5 B4 B5"),
  eighths("A4 A5 G5 A5 F5 A5 E5 A5"),
  eighths("D5 A5 C5 A5 B4 A5 A4 A5"),
  cadence(),
  [["A5", 4]],
  eighths("C6 C5 D5 C5 E5 C5 F5 C5"),
  eighths("G5 C5 A5 C5 B5 C5 C6 C5"),
  eighths("B5 B4 C5 B4 D5 B4 E5 B4"),
  eighths("F5 B4 G5 B4 A5 B4 B5 B4"),
  eighths("A5 A4 B4 A4 C5 A4 D5 A4"),
  eighths("E5 A4 F5 A4 G5 A4 A5 A4"),
  cadence(),
  [["A5", 4]],
  // The score's 8va applies only to the right hand, from measure 19.
  eighths("C6 C7 B6 C7 A6 C7 G6 C7"),
  eighths("F6 C7 E6 C7 D6 C7 C6 C7"),
  eighths("B5 B6 A6 B6 G6 B6 F6 B6"),
  eighths("E6 B6 D6 B6 C6 B6 B5 B6"),
];
const bass = {
  Am: "A2 A3 E4 C4 A4 C4 E4 C4",
  Dm: "D2 D3 A3 F3 D4 F3 A3 F3",
  G: "G2 G3 D4 B3 G4 B3 D4 B3",
  C: "C2 C3 G3 E3 C4 E3 G3 E3",
  F: "F2 F3 C4 A3 F4 A3 C4 A3",
  E: "E2 E3 B3 G#3 E4 G#3 B3 G#3",
};
const harmony = [
  "Am",
  "Am",
  "Am",
  "Dm",
  "G",
  "C",
  "F",
  "Dm",
  "E",
  "Am",
  "Am",
  "Dm",
  "G",
  "C",
  "F",
  "Dm",
  "E",
  "Am",
  "Am",
  "Dm",
  "G",
  "C",
];
const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiPitch(pitch) {
  const [, name, sharp, octave] = /^([A-G])(#?)(\d)$/.exec(pitch);
  return (Number(octave) + 1) * 12 + semitones[name] + (sharp ? 1 : 0);
}
function track(name, channel, measures) {
  const events = [
    { tick: 0, type: "trackName", text: name, meta: true },
    { tick: 0, type: "programChange", channel, programNumber: 0 },
  ];
  measures.forEach((notes, bar) => {
    let beat = 0;
    for (const [pitch, length] of notes) {
      if (pitch) {
        const noteNumber = midiPitch(pitch);
        const velocity = channel === 0 ? (bar >= 10 && bar < 18 ? 84 : 72) : 58;
        events.push(
          {
            tick: (bar * 4 + beat) * ppq,
            type: "noteOn",
            channel,
            noteNumber,
            velocity,
          },
          {
            tick: (bar * 4 + beat + length) * ppq,
            type: "noteOff",
            channel,
            noteNumber,
            velocity: 0,
          },
        );
      }
      beat += length;
    }
    if (beat !== 4)
      throw new Error(`${name}, measure ${bar + 1}: ${beat} beats`);
  });
  events.push({
    tick: measures.length * 4 * ppq,
    type: "endOfTrack",
    meta: true,
  });
  events.sort(
    (a, b) =>
      a.tick - b.tick ||
      (a.type === "noteOff" ? -1 : b.type === "noteOff" ? 1 : 0),
  );
  let previous = 0;
  return events.map(({ tick, ...event }) => {
    const deltaTime = tick - previous;
    previous = tick;
    return { deltaTime, ...event };
  });
}

const conductor = [
  {
    deltaTime: 0,
    meta: true,
    type: "trackName",
    text: "Passacaglia - opening excerpt (bars 1-22)",
  },
  {
    deltaTime: 0,
    meta: true,
    type: "text",
    text: "Transcribed from the user-supplied piano score. Remaining pages not provided.",
  },
  {
    deltaTime: 0,
    meta: true,
    type: "setTempo",
    microsecondsPerBeat: Math.round(60000000 / bpm),
  },
  {
    deltaTime: 0,
    meta: true,
    type: "timeSignature",
    numerator: 4,
    denominator: 4,
    metronome: 24,
    thirtyseconds: 8,
  },
  { deltaTime: 0, meta: true, type: "keySignature", key: 0, scale: 1 },
  { deltaTime: 8 * ppq, meta: true, type: "marker", text: "A1" },
  { deltaTime: 32 * ppq, meta: true, type: "marker", text: "A2" },
  {
    deltaTime: 32 * ppq,
    meta: true,
    type: "marker",
    text: "A1a - right hand 8va",
  },
  { deltaTime: 16 * ppq, meta: true, type: "endOfTrack" },
];
const file = process.argv[2] ?? "library/songs/passacaglia-excerpt-v1.mid";
mkdirSync(dirname(file), { recursive: true });
writeFileSync(
  file,
  Buffer.from(
    writeMidi({
      header: { format: 1, numTracks: 3, ticksPerBeat: ppq },
      tracks: [
        conductor,
        track("Right hand", 0, right),
        track(
          "Left hand",
          1,
          harmony.map((chord) => eighths(bass[chord])),
        ),
      ],
    }),
  ),
);
console.log(`Wrote ${file}: 22 bars, 130 BPM, separate left and right hands.`);
