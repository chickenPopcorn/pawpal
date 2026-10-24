import { memo, useEffect, useEffectEvent, useRef, useState } from "react";
import { books, bookForSong, CLASSES_TITLE, songsInBook } from "./books";
import type { SongBook } from "./library";
import type { Song } from "./song";
import {
  gameName,
  WORKBOOK_SERIES,
  WORKBOOK_TITLE,
  stampText,
  type Stamps,
  type WorkbookPage,
} from "./workbook";

const searchText = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const songMatches = (song: Song, term: string) =>
  searchText(
    `${song.title} ${song.lesson?.composer ?? song.source?.composer ?? ""}`,
  ).includes(term);
const pageMatches = (page: WorkbookPage, term: string) =>
  searchText(`page ${page.page} ${page.title}`).includes(term);
const allBooks = (open: boolean) =>
  Object.fromEntries(books.map(({ id }) => [id, open])) as Record<
    SongBook,
    boolean
  >;

export const SongLibrary = memo(function SongLibrary({
  songs,
  selected,
  onSelect,
  workbook,
}: {
  songs: Song[];
  /** The open song's id, or "" while a workbook page is open. */
  selected: string;
  onSelect(song: Song): void;
  /** Music Workbook 3's pages, listed after the class books. */
  workbook?: {
    pages: readonly WorkbookPage[];
    /** The open page, if any. */
    selected: number | null;
    stamps: Stamps;
    onSelect(page: number): void;
  };
}) {
  const [query, setQuery] = useState("");
  // Books start folded, even for the restored song; a later song change opens
  // that song's book.
  const [expanded, setExpanded] = useState(() => allBooks(false));
  const [workbookOpen, setWorkbookOpen] = useState(false);
  const started = useRef(false);
  const revealSelection = useEffectEvent(() => {
    const song = songs.find((song) => song.id === selected);
    if (!song) return;
    const book = bookForSong(song).id;
    setExpanded((current) => ({ ...current, [book]: true }));
    setQuery((current) =>
      song && !songMatches(song, searchText(current.trim())) ? "" : current,
    );
  });
  useEffect(() => {
    if (started.current) revealSelection();
    started.current = true;
  }, [selected]);
  const openPage = workbook?.selected ?? null;
  useEffect(() => {
    if (openPage === null) return;
    setWorkbookOpen(true);
    setQuery("");
  }, [openPage]);
  const term = searchText(query.trim());
  const groups = books.map((book) => ({
    ...book,
    songs: songsInBook(songs, book.id),
  }));
  const classes = groups.filter((group) => group.collection === "classes");
  const others = groups.filter((group) => group.collection !== "classes");
  const section = (group: (typeof groups)[number]) => {
    const visible = group.songs.filter((song) => songMatches(song, term));
    return (
      <section className="library-section" key={group.id}>
        <button
          className="library-section-toggle"
          aria-expanded={expanded[group.id]}
          aria-controls={`library-${group.id}`}
          onClick={() =>
            setExpanded((current) => ({
              ...current,
              [group.id]: !current[group.id],
            }))
          }
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
          </svg>
          <span className="library-section-icon" aria-hidden="true">
            {group.icon}
          </span>
          <span className="library-section-title">
            <small>{group.series}</small>
            {group.title}
          </span>
          <span className="library-section-count" aria-hidden="true">
            {group.songs.length}
          </span>
        </button>
        <div id={`library-${group.id}`} hidden={!expanded[group.id]}>
          <div className="library-songs" aria-label={group.title}>
            {visible.map((song) => (
              <button
                key={song.id}
                className="song"
                aria-pressed={song.id === selected}
                onClick={() => onSelect(song)}
              >
                {song.title}
                <small>
                  {song.lesson
                    ? `${song.lesson.level} · ${song.lesson.bpm} BPM · Fingering`
                    : "Full piano · No finger numbers"}
                </small>
              </button>
            ))}
            {!visible.length && (
              <p className="library-empty">
                {term
                  ? "No matches in this book."
                  : "No songs in this book yet."}
              </p>
            )}
          </div>
        </div>
      </section>
    );
  };
  return (
    <>
      <div className="nav-label">
        {CLASSES_TITLE}{" "}
        <span>
          {classes.reduce((sum, group) => sum + group.songs.length, 0)}
        </span>
      </div>
      <input
        type="search"
        className="library-search"
        aria-label="Search songs"
        placeholder="Find a song…"
        value={query}
        onChange={(event) => {
          const value = event.target.value;
          setQuery(value);
          if (value.trim()) {
            setExpanded(allBooks(true));
            setWorkbookOpen(true);
          }
        }}
      />
      {classes.map(section)}
      {workbook && (
        <section className="library-section">
          <button
            className="library-section-toggle"
            aria-expanded={workbookOpen}
            aria-controls="library-workbook-3"
            onClick={() => setWorkbookOpen((open) => !open)}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
            </svg>
            <span className="library-section-icon" aria-hidden="true">
              🖍️
            </span>
            <span className="library-section-title">
              <small>{WORKBOOK_SERIES}</small>
              {WORKBOOK_TITLE}
            </span>
            <span className="library-section-count" aria-hidden="true">
              {workbook.pages.length}
            </span>
          </button>
          <div id="library-workbook-3" hidden={!workbookOpen}>
            <div className="library-songs" aria-label={WORKBOOK_TITLE}>
              {workbook.pages
                .filter((page) => pageMatches(page, term))
                .map((page) => {
                  const day = workbook.stamps[page.page];
                  return (
                    <button
                      key={page.page}
                      className="song"
                      aria-pressed={page.page === workbook.selected}
                      onClick={() => workbook.onSelect(page.page)}
                    >
                      {`Page ${page.page} · ${page.title}`}
                      <small>
                        {gameName(page)}
                        {day ? ` · Done ${stampText(day)}` : ""}
                      </small>
                    </button>
                  );
                })}
              {!workbook.pages.some((page) => pageMatches(page, term)) && (
                <p className="library-empty">No matches in this book.</p>
              )}
            </div>
          </div>
        </section>
      )}
      {others.map(section)}
    </>
  );
});
