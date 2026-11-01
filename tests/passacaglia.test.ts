import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSong } from "../src/song";
import { validateSong } from "../src/library";
import { createBeatClock } from "../src/timeline";

describe("Passacaglia score transcription", () => {
  it("imports 22 complete bars with separate hands, cadences and the printed 8va", () => {
    const folder = mkdtempSync(join(tmpdir(), "passacaglia-"));
    try {
      const file = join(folder, "excerpt.mid");
      execFileSync(process.execPath, ["scripts/create-passacaglia.mjs", file]);
      const song = parseSong(
        new Uint8Array(readFileSync(file)),
        "Passacaglia (opening excerpt)",
        "passacaglia-excerpt-v1",
      );
      validateSong(song, song.id);
      expect(song.warnings).toEqual([]);
      expect(song.timeSignatures).toEqual([
        { tick: 0, numerator: 4, denominator: 4 },
      ]);
      const clock = createBeatClock(song.ppq, song.tempos);
      const right = song.notes.filter(
        (note) =>
          song.tracks.find((track) => track.id === note.track)?.name ===
          "Right hand",
      );
      const left = song.notes.filter(
        (note) =>
          song.tracks.find((track) => track.id === note.track)?.name ===
          "Left hand",
      );
      expect(right).toHaveLength(140);
      expect(left).toHaveLength(176);
      expect(right.slice(0, 8).map((note) => note.pitch)).toEqual([
        72, 84, 83, 84, 81, 84, 79, 84,
      ]);
      expect(left.slice(0, 8).map((note) => note.pitch)).toEqual([
        45, 57, 64, 60, 69, 60, 64, 60,
      ]);
      expect(clock.at(right[0].start)).toBeCloseTo(8);
      const atBar = (bar: number) =>
        right.filter((note) => {
          const beat = clock.at(note.start);
          return beat >= (bar - 1) * 4 - 1e-6 && beat < bar * 4 - 1e-6;
        });
      expect(atBar(9).map((note) => note.pitch)).toEqual([81, 80, 78, 80, 81]);
      expect(
        atBar(9).map(
          (note) =>
            Math.round((clock.at(note.end) - clock.at(note.start)) * 1e6) / 1e6,
        ),
      ).toEqual([1, 0.5, 0.5, 1.5, 0.5]);
      expect(atBar(19).map((note) => note.pitch)).toEqual([
        84, 96, 95, 96, 93, 96, 91, 96,
      ]);
      expect(
        clock.at(Math.max(...song.notes.map((note) => note.end))),
      ).toBeCloseTo(88);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
