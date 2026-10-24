# The song library

[← Back to the README](../README.md)

The songs live in the Supabase bucket `library`, not in this repository. Only
signed-in users can read it (see [who can read the buckets](#who-can-read-the-buckets)).
The app loads them after sign-in:

- `index.json` lists the songs in order, with each one's title, collection
  (`classes`, `movies`, `songs` or `pops`) and file names. The app loads
  `classes`, George Bear’s Classes, and `movies`, Movie Themes; the bucket also
  keeps the other two collections. A `classes` song may name its `book`:
  `recital-3` (the default) or `lesson-3`. Movie Themes is one book.
  Browsers check the index on every load; it is cached for 60 seconds.
- `songs/<id>.<hash>.json` is each song in the app's format: notes, tracks,
  tempo, suggested fingering and lesson text, and for Recital Book 3 the
  teacher duet (`duet`: its notes, and how many octaves the student part moves
  with it).
- `songs/<id>.<hash>.mid` is each song's MIDI file, for its Download button.

Each file is named after its content hash and cached for a year, so a repeat
visit downloads only `index.json`; a changed song gets a new name.

The app reads each file as the signed-in user: it requests
`/storage/v1/object/authenticated/library/<path>` with the session's access
token in the `Authorization` header (`signedInFetch` in `src/supabase.ts`).
The token is not part of the URL, so each file keeps one URL and the browser
cache works as before. Storage answers these requests with
`Cache-Control: private` and `Vary: Authorization`: while the access token
stays the same, the browser uses a cached song file without asking; once
Supabase renews the token (hourly), it sends one conditional request per file
and gets `304 Not Modified`, without downloading the file again. The **Download
MIDI** button fetches the MIDI file the same way and saves it from the page,
since a plain link would not carry the token.

## Changing the library

To change the library, run `npm run library:pull`, edit `./library` (ignored by
git), then run `npm run library:push`. To add a song, put its MIDI file at
`library/songs/<id>.mid` and add an entry to `library/index.json` with its `id`,
`title`, `collection` (`"classes"` or `"movies"`), for a class song an optional
`book`, `song: "songs/<id>.json"` and `midi: "songs/<id>.mid"`; push converts
the MIDI into the song file. A build of the app rejects an index that names a
collection it does not know, so push a song in a new collection only once the
build that knows it is live (and 10 minutes have passed, as below). Each
song file records the hash of the MIDI file it was built from (`sourceMidi`),
and push refuses a MIDI file that a song file was not built from. `./library`
uses plain names; push adds the hashes. Push checks every song (and the 5 MiB
file limit) before it uploads anything, uploads the index last, and removes a
file only 24 hours after the index stops listing it, since a browser may still
be loading it from an earlier index (`retired.json` in the bucket records when
each file left). Pulling and pushing both need the project's secret key, in
`SUPABASE_SECRET_KEY`, or a Supabase account token in `MUSIC_API_KEY` to look it
up (`scripts/supabase-admin.mjs`). The app itself only reads the bucket. A copy
of three songs in `tests/fixtures/` serves the tests.

## The course CD's audio

The MP3 files of the course CD, _Music for Little Mozarts: Lesson and
Discovery, Level 3_ (Alfred Music, 2015), live in the private bucket
`cd-audio`, apart from `library`, whose push removes files its index does not
list. The recordings are copyrighted: they never go into this repository. The
app plays the story tracks, with the **Story** button (see
[how the app uses them](#how-the-app-plays-the-story)).

- `mflm-3/disc-<n>/<nn>.mp3` is each of the 112 tracks, by disc and track
  number (`mflm-3/disc-1/15.mp3` is disc 1, track 15), as `audio/mpeg`, cached
  for a year.
- `mflm-3/manifest.json` lists every track: `disc`, `track`, its `title` on
  the CD, `kind`, `audio` (its path), `bytes` and `sha256`. Disc 1 follows
  Lesson Book 3: tracks 3, 5, … 85 are its 42 pieces in book order (`song`,
  with the library song's `songId`), each played, counted in for two bars and
  played again; the tracks between tell the story (`story`). Disc 2 is the
  Discovery book (`discovery`). Two titles on the CD differ from the book's:
  track 57, "Beethoven's Bear Amazing Trick", is
  `pawpal-beethoven-bears-amazing-trick-v1`, and track 81, "The Bowling
  Song", is `pawpal-the-bowing-song-v1`. The manifest is cached for 60
  seconds.

`npm run cd-audio:push -- <folder>` uploads the folder of the CD's MP3 files,
named as ripped (`Disc 1 - 15 Finger 3 on E.mp3`), with the same secret key
as the library. It checks every file name and matches each piece to the
`lesson-3` songs of the library's `index.json` before it uploads, skips a
track already in the bucket with the same size, and uploads the manifest last.
A recording is never replaced under the same name, since browsers keep each
for a year; add `--dry-run` to check the folder and print the manifest
without uploading.

### How the app plays the story

The **Story** button on a piece of Lesson Book 3 plays the story tracks just
before that piece on disc 1: the track before it, and for the first piece
(track 3) the opening story too, tracks 1 and 2 in turn. The closing story,
track 86, comes after the last piece and is not played, nor is disc 2
(`src/story.ts`).

The app reads `mflm-3/manifest.json` once per page, as the signed-in user
(`signedInFetch`), the first time a piece of Lesson Book 3 is shown; if it
cannot, no piece shows the button, and the next piece of Lesson Book 3 shown
tries again. A story's tracks are fetched only when it plays, the same way,
and play from object URLs on an audio element of their own, apart from the
piano's Web Audio. The last four tracks played stay in memory for a story
played again, and are freed when the studio closes, as on sign-out.

## Who can read the buckets

Both buckets answer only signed-in users: the `authenticated` role, through
the `select` policies on `storage.objects` in
`supabase/migrations/20261019150000_signed_in_storage.sql`. Anonymous
sessions are left out. Only the secret key, which row-level security does not
limit, writes to them. Signed in means any Google account: the project lets
every Google account sign up, and nothing limits sign-in to particular
accounts, so anyone with a Google account who signs in to Paw Pal can read the
songs and the CD's audio. A signed-in user can also create signed URLs for
these files, which work without signing in until they expire.

`cd-audio` is private. `library` stays public until the app that reads it as
the signed-in user is live; its public URLs keep working for the app before
it. To make it private, in this order:

1. Apply `20261019150000_signed_in_storage.sql` (applied on 2026-10-19).
2. Merge the app change and let the Pages workflow deploy it to
   piano.pollos.us. Check that the live site loads its songs from
   `/storage/v1/object/authenticated/library/` (the browser's Network panel).
3. Wait at least 10 minutes, so no browser still holds the earlier
   `index.html` (GitHub Pages lets browsers keep it that long).
4. Apply `20261019160000_private_library.sql`, which sets `public = false` on
   `library` (or turn off **Public bucket** for `library` under Storage in the
   Supabase dashboard).
5. Check: `https://ochjekqgxkojrilgsqud.supabase.co/storage/v1/object/public/library/index.json`
   answers with an error, the same request on
   `/storage/v1/object/authenticated/library/index.json` with only the
   publishable key answers `Object not found`, and the live site still opens
   with its songs after a reload.

To undo step 4, set `public = true` on `library` again.

## MIDI file support

`npm run library:push` converts library MIDI files with the app's parser. Standard MIDI formats **0 and 1** with ticks-per-beat division are supported, including tempo changes across tracks, FIFO pairing of overlapping notes, velocity-zero releases, and channel-wide CC64 sustain. Converted notes keep physical release and sound end separately. Format 2 and SMPTE division produce actionable unsupported-file errors. MIDI files are limited to 10 MB, 256 declared tracks (including empty tracks), 50,000 positive-velocity note attacks, and 500,000 MIDI events. A bounded byte scanner checks both event budgets before the full MIDI parser allocates event objects. Missing note-offs are closed at the track boundary with a warning. Track names do not establish hand assignment; normalized display names are limited to 160 characters. Playback does not reproduce General MIDI instruments, effects, or drum kits.
