# Practicing with Paw Pal

[← Back to the README](../README.md)

## The classes

Paw Pal is for one learner: the library is **George Bear’s Classes**, one
section per class book of _Music for Little Mozarts_:

- **Music Recital Book 3**: all 21 personal-practice pieces in the book (pages
  4–31), in C and Middle C positions. Dancing Raindrops keeps its supplied
  chords and articulation. The other twenty are transcriptions that keep the
  student parts' printed rests, chords, staccato, dynamics, repeats and finger
  numbers, without lyrics. Each piece also has its printed teacher duet.
- **Music Lesson Book 3**: all 42 pieces in the book (pages 5–47), in C and
  Middle C positions, transcribed the same way, each with its printed teacher
  duet.

Each song includes suggested finger numbers on the score, falling notes, active
keys and Wait for me practice, plus starting hand positions. The library
bucket holds every song, its book and the order within each book; see
[the song library](library.md).

After them come Music Workbook 3 (below) and **Movie Themes**, full piano
arrangements of film music, such as Joe Hisaishi's _Summer_ from _Kikujiro_.
Their hands, finger numbers and starting positions are suggestions worked out
from the notes, not from a printed score.

Books start folded; click one to open it. Searching opens them all, and moving
to a song in another book opens that one.
Search the classes by title or composer. **Download MIDI** saves the selected
song as a standard MIDI file.
On a piece of Lesson Book 3, **Story** plays the course CD's story that leads
into it (for the first piece, the CD's opening story too); click it again to
stop. Starting it pauses practice, and it stops when practice starts, another
song opens or the piano goes full screen.
The files have separate left/right tracks, one full silent count-in bar, tempo,
and finger numbers as text events. The count-in keeps musical downbeats aligned
with barlines. General MIDI players may ignore these text events.

## Music Workbook 3

After the class books comes _Music for Little Mozarts, Music Workbook 3_.
Each page is a game played on the piano:

- **Crayon Keys** (pages 7, 9, 11, 14, 36, 37, 38 and 42) paints the named
  keys, and on pages with a staff its note too.
- **Color by Note** (pages 4, 8, 10, 12, 21 and 48) paints each area of a
  picture by its note. Where the book names only a letter ("an F"), every F
  in the picture counts, in either clef.
- **Color by Note with intervals** (pages 26, 33 and 45) outlines one area at
  a time. The child plays its two notes as written, together or left then
  right, and the area takes its interval's crayon.
- **Interval Hop** (pages 13, 19, 23, 39 and 43) first colors the note heads
  the book names by letter, then plays each card's two notes, left then
  right. The card is circled in its step's crayon (2nds going up, going
  down; steps, skips and repeats), and a paw hops over the keyboard from the
  first key to the second.
- **Interval Hop Find pages** (20, 24, 40 and 44) ask for one interval among
  mixed cards. The child plays a card that holds it, and passes over any
  other card with **G5**, the answer key whose sticker says Skip (on the
  computer keyboard, **L**).
- **Interval Hop How far?** (41): the child plays each card, then presses how
  far apart its notes are on the answer keys: **G5** is 2, **A5** is 3 and
  **B5** is 4 (on the computer keyboard L, ; and ').
- **Hold It!** (6, 15 and 16) plays on any key while the laptop's metronome
  counts: hold each note for its counts, play short where there is a
  staccato dot and a full count where there is not, and rest for each
  rest's counts between two notes.
- **Ear Detective** (17, 18, 22, 25, 27 and 46): **C2** plays the example, a
  clapped rhythm or a melody; the child plays it back, and the example heard
  is circled. If the echo matches neither option, **G5** (top) and **A5**
  (bottom) answer instead.
- **Together or Apart** (5, 29, 31, 32 and 35): circle the notes played
  together or separately, or the examples played hands together, skipping
  the others with **G5**; or say which hand plays each example (**G5** is LH,
  **A5** is RH) and play it, legato where there is a slur.
- **Note Snap** (30 and 34) lights each staff card in turn; playing its note
  draws a line to the matching letter.
- **Interval Hop Same and Different** (28 and 47): the child plays each box's
  top card, then its bottom card, then presses **G5** for Same or **A5** for
  Different (on the computer keyboard L and ;).

The steps go in the book's order; a wrong key gets a hint, and after two
misses the letter names appear on the keys. A finished page gets a date
stamp, kept in this browser.

Once a page is open, the piano does everything, so the child never needs the
mouse:

- **C2**: hint (letter names on the keys)
- **D2**: previous page; hold 2 seconds to leave the workbook
- **E2**: next page
- **F2**: hold 2 seconds to start the page over

The page's notes are between C3 and C5. The computer shortcuts also play
them; on a workbook page L, ; and ' are G5, A5 and B5, and 1 to 4 are C2,
D2, E2 and F2. See [Workbook games](workbook-games.md) for every page's plan.

## Score, waterfall and shortcuts

The sheet-music timeline above the waterfall follows the current bar. Accepted
notes fade to 50% opacity in practice modes; Listen marks the notes as it plays
them. Disabled hands remain visible at half opacity. Written
rhythms and rests are preserved for the lessons; a song built from plain MIDI
uses approximate note values derived from performed timing.
Click a note or drag across the score to change playback position. The focused
score also supports Shift+arrow for a bar and Home/End. Left/Right arrow keys
select the previous/next song in the current book and start playback,
as do the Previous/Next buttons in full screen. Mode,
restart, playback, speed, time and full-screen controls share the row above the
score.
Full screen expands the score and waterfall and starts the selected practice
mode. Enter opens full screen and starts playback; it also resumes a paused
full-screen session. Space pauses or resumes in either view. These
shortcuts stay inactive while editing a field. Escape returns to the page;
playback controls remain available in either view. The finger guide always shows
animated bear paws directly from the source, with no saved display preference.
Reduced-motion settings disable their animation.
On both hands, 1 means thumb and 5 means little finger. Changing a track to the
opposite hand hides its original fingering; a song built from plain MIDI gets
no guessed finger numbers.

## Practicing a piece

1. Choose a piece from George Bear’s Classes; use **Find a song** to filter them.
2. Click **Connect your piano** in the header to grant MIDI permission the first time; it changes to **Piano connected**. See [MIDI and USB pianos](midi.md) for reconnecting and choosing an input.
3. Choose **Listen**, **Wait for me**, or **Rhythm**, enable one or both hands, and press Play. Listen plays your part for you and works without a piano. In Wait for me and Rhythm the app never plays your part: you do. Computer shortcuts and clickable on-screen keys also provide practice input. Turn on **Duet** beside the hands to hear the book's teacher part play along, in every mode (see [Duet](#duet)). In Listen and Rhythm, the **Metronome** button beside the loop button clicks every beat after a count-in (see [Metronome](#metronome)).
4. Slow down (20–140%, in 20% steps), seek or restart, and set passage boundaries in song seconds using A/B or the numeric fields. Looping is on by default and repeats the full song or selected passage. Turn it off with the loop button; that choice and the passage bounds are remembered for each song.

## Modes

What the app plays depends on the mode:

| Mode        | Duet off                 | Duet on                               |
| ----------- | ------------------------ | ------------------------------------- |
| Listen      | your part (chosen hands) | your part and the teacher duet        |
| Wait for me | nothing                  | the teacher duet, which waits for you |
| Rhythm      | nothing                  | the teacher duet                      |

The only difference between Wait for me and Rhythm is that Wait for me stops at
each note until you play it, and Rhythm does not.

**Wait for me** accepts correct notes up to the selected timing tolerance early and holds the shared timeline at each remaining note/chord until every chord pitch has been pressed and is physically held. Accepting an early note does not jump the timeline forward. Repeated notes need a release and fresh press; a sustain pedal cannot satisfy a physical chord. The keys to play are highlighted on the keyboard and the score, and announced to screen readers.

**Rhythm** keeps moving and matches note onsets using MIDI event timestamps. Timing tolerance is configurable (±120, ±220 or ±350 ms of real time, independent of playback speed). Feedback identifies missed/wrong notes and early/late matched notes; click a missed note to loop a short passage around it. This MVP scores pitch and onset timing, not fingering or held-note duration.

## Duet

Turn on **Duet** beside the hands to hear the book's teacher part play along,
in every mode. As the book asks, the student part then usually moves up one
octave; some pieces move it up two octaves or down one, and a few keep it as
written. The waterfall, keyboard shortcuts and finger guide follow it, and the
score keeps the written notes under an 8va, 15ma or 8vb mark.

The on-screen keyboard follows the student's part only, as it does with Duet
off: whole octaves around your notes, at least C3 to C6, moving with the
octave shift. The duet never widens it. The waterfall shows the duet in yellow
at quarter opacity behind your notes, wherever it falls on the keys your part
uses; the duet is never fingered or scored, and Wait for me holds it at each of
your notes until you play them.

## Metronome

The **Metronome** button beside the loop button clicks every beat of the
song, in Listen and Rhythm. It is off until turned on, and the choice is
remembered. Each bar's first beat clicks higher. The click follows the
song's tempo and time signature, so it clicks each quarter in 4/4 and 3/4
and each eighth in 6/8, and it slows down and speeds up with **Speed**.

With the metronome on, Play first counts in: the clicks from the start of
the bar up to where playback starts, or the whole bar before it when that
leaves fewer than two clicks, as on a bar's first beat. From the start of a
lesson in 4/4 the count is "1, 2, 3", and the song's lead-in beat is "4". The
music, the score and the waterfall stay still during the count. Pause stops
it, a seek counts in again from the new place, even during playback, and a
loop goes on to its next pass without one. Turning the metronome off during
the count starts the music at once, and turning it on during playback counts
in from there. In Rhythm, a note played early as the count ends scores as
early, as it would during playback.

Wait for me has no metronome: the music waits for you there, so there is no
beat to keep. The click is a short tone that leaves out the piano's room, and
it always plays on the laptop, even when the music plays on a USB piano (see
[MIDI and USB pianos](midi.md#play-the-apps-sound-on-a-usb-piano)). Keep the
laptop's sound on to hear it.

## Limits

Laptop audio coalesces duplicate pitches at the same onset and allows at most 64 active or scheduled voices, including previews. Extremely dense material can omit excess voices; MIDI input and scoring remain independent. The waterfall coalesces duplicate note shapes and draws at most 4,096 distinct visible rectangles per frame; the full note set still drives scoring. Recent feedback is limited to 256 entries and six missed-note replay anchors, with full-passage note counts, wrong-press totals and average timing retained separately.

## Sound

Your physical piano supplies live piano sound, and when it has a MIDI output it plays all of the app's sound too (see [Play the app's sound on a USB piano](midi.md#play-the-apps-sound-on-a-usb-piano)). Without a MIDI output, Listen, the duet and on-screen keys play on the laptop with Accurate-Salamander Grand Piano 6.2a: all sixteen recorded intensity layers of a Yamaha C5, in lossless 24-bit stereo FLAC. The player preserves the source preset’s per-key tuning, attack offsets and volume balance, with natural release tails. Only the recordings needed for the selected notes and velocities load before playback; decoded samples are reused within a 512 MiB cache. Very large selections may need one hand or a shorter loop. The player also includes the preset's optional recorded details: string harmonics when a key is released with the pedal up, key release noise, pedal noise, and pseudo pedal resonance for notes struck with the pedal down. These load only for the notes and pedal changes that trigger them. The complete bundled sample bank is about 753 MiB, but it is not downloaded in full on page load. No external audio service is contacted. Recording credits, adaptation details and the CC BY 3.0 license are in [the sample credits](../public/audio/accurate-salamander/CREDITS.md). Leaving the page hidden pauses playback to avoid invisible practice and background scheduling gaps.

### Piano sound

Open **Piano sound** in the settings row below the keyboard, beside Note names.
It shapes the laptop's sound; a USB piano's MIDI output uses the piano's own.
**Natural** is the only piano sound, with gentler compression and subtle stereo
room ambience. Adjust **Room** while listening; its level is remembered in this
browser, across songs.
Changes do not restart notes or the practice timeline. Pause, seek and song changes
clear the room tail as well as scheduled notes.

Playback uses all sixteen recorded layers. The room is a small synthetic
convolution ambience. Under **Recorded details**, turn the preset's optional
release harmonics, key release noise, pedal noise and pedal resonance on or
off; these are remembered in this browser. Turning one off stops it at once.
Turning one on during playback restarts playback at the same place so that its
recordings can load. These
voices follow a song's sustain pedal (CC64); built-in lessons have
no pedal, so they use only release harmonics and key noise. See the
[adaptation notes](../public/audio/accurate-salamander/LICENSE.md) for how each
voice follows the SFZ preset.

## Practice calendar

The practice calendar at the top of the sidebar shows this month under the learner's name ("George’s practice"): a star on each day that met the daily goal, a dot on days with less, and a ring filling up for today, with the current streak. Each week, Monday to Sunday, ends with a stamp that stays grey until all seven days have their star, counting days of a week that fall in the next or previous month. The goal is 5 minutes unless changed under **Edit** (5, 10, 15, 20 or 30), where the learner's name can also be changed; it starts as the first name on the signed-in Google account. Practice time counts only while a song plays in Wait for me or Rhythm and a key was pressed within the last 15 seconds; Listen, paused time and a Wait gate left waiting do not count. Days follow the device's local calendar. Playing time is kept in localStorage as sessions, one per page visit per day with seconds per song, for the last 92 days, today included. Each session has its own key, written only by the tab that plays it, so tabs on the same browser add up without overwriting each other.
