# Accounts and data

[← Back to the README](../README.md)

## Sign-in

Sign-in with Google is required to open the studio. Supabase (project `pawpal`) handles the sign-in and returns to the page it started from; it only returns to addresses in the project's redirect allow list (`https://piano.pollos.us/**` and localhost). **Sign out** in the header signs out this browser only; other devices stay signed in.

Any Google account can sign in: sign-up is open, and no list limits it to particular accounts. Everything that needs sign-in, including the song library and the course CD's audio, is therefore open to anyone with a Google account who signs in.

## What the account keeps

Supabase holds each user's settings, practice progress and practice time, and row-level security limits every row to the user who owns it:

- `settings`: one row per user, the studio settings.
- `progress`: per song, the position, track assignments, passage, number of starts, and best matched-note proportion. Each account keeps at most 200 songs' progress, 16 KiB each (`progress_quota`), which a direct Data API caller cannot exceed either. The position and passage are kept in beats along with the song's version, a hash of its notes' pitches and beats (`songVersion` in `src/song.ts`), so a tempo change to a library song keeps them on the same bars, and a passage that ran to the song's end still does. A save from a different version of the song's notes, or from before versions were kept (in seconds), starts the position and passage over; the rest of the song's progress stays.
- `practice_sessions`: the practice calendar's sessions, one row per page visit per local day: the day, the seconds played and the seconds per song. The browser makes up each session's id and re-sends its running total, so a repeated upload never counts twice and two devices add up; an upload never lowers a session's time (`practice_sessions_never_shrink`). A new session's day must be within the last 100 days, and an account keeps at most 50 sessions a day (`practice_sessions_quota`).

The account is the record. At sign-in the browser takes the account's settings and progress (the first account on a browser also takes progress saved there before sign-in, where the account has none), and its practice sessions from the calendar's 92 days, keeping the larger copy of each; sessions only this browser has, such as ones played before the account kept practice time, upload. Changes upload about two seconds after they happen, one upload at a time; a failed upload stays queued in localStorage, survives a reload and is retried, and a request that takes over 30 seconds is aborted. The server merges progress uploads (`progress_merge` trigger): the best proportion and the number of starts only grow, and position, passage and hands follow whichever copy was saved later, so a late upload from one device never undoes practice from another. Only one tab runs the studio at a time; another tab offers to move it there. Signing out uploads what is waiting first and asks before dropping anything that could not upload; it then clears this browser's copy of the account's settings, progress and practice sessions. Signing in with a different account clears the previous one's copy, including anything it had not uploaded. Best proportion uses all eligible notes in the current passage, including upcoming notes.

The songs come from the shared library bucket (see [the song library](library.md)), the same for everyone, read-only, and readable only when signed in. The app has no MIDI import. Songs imported by earlier versions stay in this browser's IndexedDB, untouched; the app no longer reads them. MIDI input from your piano is never uploaded. There is no analytics, billing, Bluetooth integration, sheet-music recognition, or teacher dashboard.

After a refresh, the page as it was left shows again at once, but only while this browser still holds an unexpired sign-in for the same account (`index.html`, `src/reloadSnapshot.ts`).

## Supabase setup

The app needs two public values: the Supabase project URL and its publishable key (Supabase dashboard → Project Settings → API Keys). For local development, put them in `.env.local`, which git ignores:

```sh
VITE_SUPABASE_URL=https://ochjekqgxkojrilgsqud.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Deployment reads the same two names from the repository's GitHub Actions variables. The publishable key only allows what row-level security allows; never use the secret key here. The schema, including the buckets and who can read them, is in `supabase/migrations/`. Nothing applies the migrations automatically: run each new one's SQL once, in order, in the Supabase dashboard's SQL Editor or through the Management API (`POST https://api.supabase.com/v1/projects/ochjekqgxkojrilgsqud/database/query` with an account token). `20261019160000_private_library.sql` waits for the app that reads the library as the signed-in user; see [the song library](library.md#who-can-read-the-buckets).
