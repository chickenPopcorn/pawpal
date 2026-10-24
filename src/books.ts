import type { LibraryCollection, SongBook } from "./library";
import type { Song } from "./song";

/** George’s piano classes, the library's main collection. */
export const CLASSES_TITLE = "George Bear’s Classes";

/** One section per book, in this order: the class books, then Movie Themes. */
export const books = [
  {
    id: "recital-3",
    collection: "classes",
    series: "Music for Little Mozarts",
    title: "Music Recital Book 3",
    icon: "🎹",
  },
  {
    id: "lesson-3",
    collection: "classes",
    series: "Music for Little Mozarts",
    title: "Music Lesson Book 3",
    icon: "📖",
  },
  {
    id: "movies",
    collection: "movies",
    series: "Piano Solos",
    title: "Movie Themes",
    icon: "🎬",
  },
] as const satisfies readonly {
  id: SongBook;
  collection: LibraryCollection;
  series: string;
  title: string;
  icon: string;
}[];
export type Book = (typeof books)[number];

export function bookForSong(song: Song | undefined): Book {
  return books.find((book) => book.id === song?.library?.book) ?? books[0];
}

export const songsInBook = (songs: readonly Song[], id: SongBook) =>
  songs.filter((song) => bookForSong(song).id === id);
