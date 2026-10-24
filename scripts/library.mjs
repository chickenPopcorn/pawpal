// Edit the shared song library, which lives in the Supabase `library` bucket.
//
//   npm run library:pull   Download the bucket into ./library for editing.
//   npm run library:push   Check ./library and upload it to the bucket.
//
// ./library holds index.json and songs/<id>.json + songs/<id>.mid. To add a
// song, put its MIDI file at songs/<id>.mid and list it in index.json with an
// id, title and collection: push converts the MIDI into songs/<id>.json. The
// app shows the `classes` collection, George Bear's Classes, where a song may
// name its book (recital-3, the default, or lesson-3), and `movies`, Movie
// Themes.
// Each song file records the hash of the MIDI file it was built from
// (`sourceMidi`), and push refuses a MIDI file the song file was not built
// from, so practice and the Download button always agree.
// The bucket names each file after its content hash (songs/<id>.<hash>.json),
// so browsers can keep it for a year: a changed song gets a new name. A file
// the index stops listing is removed 24 hours later (see retired.json).
// Only signed-in users may read the bucket, so pulling and pushing both use
// the project's secret key (see scripts/supabase-admin.mjs).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer } from "vite";
import { adminClient } from "./supabase-admin.mjs";

const FOLDER = "library";
/** Hashed files never change, so browsers and the CDN may keep them this long. */
const FOREVER = "31536000";
/** The bucket's largest file (file_size_limit in its migration). */
const MAX_FILE = 5 * 1024 * 1024;
/** The index changes on every push. */
const BRIEF = "60";
/**
 * A file stays this long after the index stops listing it: a browser may still
 * be loading it from an index fetched just before the push.
 */
const RETIRE_MS = 24 * 60 * 60 * 1000;
/**
 * The working copy's name for a song's file. It comes from the id, since an
 * id may itself end in what looks like a hash.
 */
const plainName = (id, key) => `songs/${id}.${key === "song" ? "json" : "mid"}`;
const command = process.argv[2];
if (command !== "pull" && command !== "push") {
  console.error("Usage: node scripts/library.mjs pull|push");
  process.exit(1);
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
try {
  const { LIBRARY_BUCKET, validateIndex, validateSong } =
    await server.ssrLoadModule("/src/library.ts");
  const storage = (await adminClient()).storage.from(LIBRARY_BUCKET);
  if (command === "pull") await pull(storage, validateIndex);
  else await push(storage, LIBRARY_BUCKET, validateIndex, validateSong);
} finally {
  await server.close();
}

/** A file from the bucket, read past the CDN so it is current. */
async function download(storage, path) {
  const { data, error } = await storage.download(path, {
    cacheNonce: Date.now(),
  });
  if (error) throw new Error(`${path}: ${error.message}`, { cause: error });
  return new Uint8Array(await data.arrayBuffer());
}

async function pull(storage, validateIndex) {
  const index = validateIndex(
    JSON.parse(new TextDecoder().decode(await download(storage, "index.json"))),
  );
  const songsFolder = resolve(FOLDER, "songs");
  mkdirSync(songsFolder, { recursive: true });
  // The working copy uses plain names; push adds the hashes again.
  for (const entry of index.songs) {
    for (const key of ["song", "midi"]) {
      if (!entry[key]) continue;
      const original = entry[key];
      entry[key] = plainName(entry.id, key);
      // validateIndex allows only songs/<id>.json and .mid; check again here,
      // since this writes into the repository.
      const target = resolve(FOLDER, entry[key]);
      if (dirname(target) !== songsFolder)
        throw new Error(
          `${entry.id}: ${entry[key]} is outside ${FOLDER}/songs`,
        );
      writeFileSync(target, await download(storage, original));
    }
    delete entry.hash;
    delete entry.midiHash;
  }
  writeFileSync(`${FOLDER}/index.json`, JSON.stringify(index, null, 2) + "\n");
  console.log(`Pulled ${index.songs.length} songs into ./${FOLDER}`);
}

async function push(storage, bucket, validateIndex, validateSong) {
  const { parseSong } = await server.ssrLoadModule("/src/song.ts");
  const index = validateIndex(
    JSON.parse(readFileSync(`${FOLDER}/index.json`, "utf8")),
  );
  // The working copy uses plain names. One copied from the live index has
  // hashes; drop them, so each published name carries exactly one.
  for (const entry of index.songs) {
    entry.song = plainName(entry.id, "song");
    if (entry.midi) entry.midi = plainName(entry.id, "midi");
  }
  const hash = (bytes) =>
    createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const hashed = (path, bytes) => path.replace(/(\.\w+)$/, `.${hash(bytes)}$1`);
  const files = [];
  /** The index as published: every path carries its file's hash. */
  const published = structuredClone(index);
  // The live index, to notice a MIDI file replaced without its song data.
  // Only a bucket with no index yet (the first push) goes without; any other
  // failure stops the push rather than skip the check.
  let live;
  try {
    live = JSON.parse(
      new TextDecoder().decode(await download(storage, "index.json")),
    );
  } catch (error) {
    const { statusCode, message } = error.cause ?? {};
    if (String(statusCode) !== "404" || !/object not found/i.test(message))
      throw new Error(`Could not read the live index.json; try again.`, {
        cause: error,
      });
    live = { songs: [] };
  }
  const hashOf = (path) => /\.([0-9a-f]{16})\.\w+$/.exec(path ?? "")?.[1];
  const before = new Map(
    (live.songs ?? []).map((song) => [
      song.id,
      { song: hashOf(song.song), midi: hashOf(song.midi) },
    ]),
  );
  // Check every song before uploading anything.
  for (const entry of index.songs) {
    const songPath = `${FOLDER}/${entry.song}`;
    const midiPath = entry.midi && `${FOLDER}/${entry.midi}`;
    if (midiPath && !existsSync(midiPath))
      throw new Error(`${entry.id}: missing ${midiPath}`);
    const midiBytes = midiPath && readFileSync(midiPath);
    if (!existsSync(songPath)) {
      if (!midiPath) throw new Error(`${entry.id}: missing ${songPath}`);
      const song = parseSong(new Uint8Array(midiBytes), entry.title, entry.id);
      song.sourceMidi = hash(midiBytes);
      writeFileSync(songPath, JSON.stringify(song, null, 1) + "\n");
      console.log(`Converted ${midiPath} into ${songPath}`);
    }
    if (midiPath) {
      // The app plays the song file and offers the MIDI file for download,
      // so the song file must come from this MIDI file.
      const song = JSON.parse(readFileSync(songPath, "utf8"));
      const was = before.get(entry.id);
      if (song.sourceMidi === undefined) {
        // A song file from before this record: vouch for it only if its
        // MIDI file is the one already published with it. A new song needs
        // its record, or a song file built here from its MIDI file.
        if (was?.midi !== hash(midiBytes))
          throw new Error(
            `${entry.id}: ${entry.song} does not say which MIDI file it was ` +
              `built from, and ${entry.midi} is not the one published with ` +
              `it. Delete ${entry.song} to rebuild it from the MIDI file ` +
              `(that drops any lesson details and fingering), or set its ` +
              `sourceMidi to ${hash(midiBytes)} once it matches.`,
          );
        song.sourceMidi = hash(midiBytes);
        writeFileSync(songPath, JSON.stringify(song, null, 1) + "\n");
      } else if (song.sourceMidi !== hash(midiBytes))
        throw new Error(
          `${entry.id}: ${entry.song} was built from a different MIDI file ` +
            `than ${entry.midi}. Update ${entry.song} to match, or delete it ` +
            `to rebuild it from the MIDI file (that drops any lesson details ` +
            `and fingering).`,
        );
    }
    const songBytes = readFileSync(songPath);
    validateSong(JSON.parse(songBytes.toString("utf8")), entry.id);
    const out = published.songs.find((song) => song.id === entry.id);
    delete out.hash;
    delete out.midiHash;
    out.song = hashed(entry.song, songBytes);
    files.push([out.song, songBytes, "application/json"]);
    if (midiPath) {
      out.midi = hashed(entry.midi, midiBytes);
      files.push([out.midi, midiBytes, "audio/midi"]);
    }
  }
  const indexBytes = Buffer.from(JSON.stringify(published, null, 2) + "\n");
  // The bucket refuses larger files, so stop before uploading any.
  for (const [path, bytes] of [...files, ["index.json", indexBytes]])
    if (bytes.length > MAX_FILE)
      throw new Error(`${path} is larger than the bucket's 5 MiB file limit.`);

  const upload = async (path, bytes, contentType, cacheControl) => {
    const { error } = await storage.upload(path, bytes, {
      contentType,
      upsert: true,
      cacheControl,
    });
    if (error) throw new Error(`Upload ${path}: ${error.message}`);
  };
  for (const [path, bytes, type] of files)
    await upload(path, bytes, type, FOREVER);
  // The index goes last, so it never lists a file that is not there yet.
  await upload("index.json", indexBytes, "application/json", BRIEF);

  // retired.json records when each unlisted file left the index. Files are
  // removed only once they have been unlisted for RETIRE_MS, however many
  // pushes happen meanwhile.
  const now = Date.now();
  const listed = new Set(files.map(([path]) => path));
  const retired = await readRetired(storage);
  const keep = {};
  const stale = [];
  for (const path of await listAll(storage, "songs")) {
    if (listed.has(path)) continue;
    const since = retired[path] ?? now;
    if (now - since >= RETIRE_MS) stale.push(path);
    else keep[path] = since;
  }
  if (stale.length) {
    const { error: removal } = await storage.remove(stale);
    if (removal) throw new Error(`Remove old files: ${removal.message}`);
  }
  await upload(
    "retired.json",
    Buffer.from(JSON.stringify(keep, null, 2) + "\n"),
    "application/json",
    BRIEF,
  );
  console.log(
    `Pushed ${index.songs.length} songs to the ${bucket} bucket` +
      (stale.length ? `, removed ${stale.length} old files` : "") +
      (Object.keys(keep).length
        ? `, kept ${Object.keys(keep).length} unlisted files for now`
        : ""),
  );
}

/** Every file path in a bucket folder, a page at a time. */
async function listAll(storage, folder) {
  const paths = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await storage.list(folder, { limit: 1000, offset });
    if (error) throw new Error(`List ${folder}/: ${error.message}`);
    paths.push(...data.map((file) => `${folder}/${file.name}`));
    if (data.length < 1000) return paths;
  }
}

/** When each unlisted file left the index. Read past the CDN, so it is current. */
async function readRetired(storage) {
  const { data, error } = await storage.download("retired.json");
  // Missing on the first push. A file with no record counts as leaving now,
  // so losing the record only keeps files longer.
  if (error) return {};
  try {
    return JSON.parse(await data.text());
  } catch {
    return {};
  }
}
