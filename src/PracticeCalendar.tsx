import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { addDays, localDay, streak } from "./practiceLog";
import { DAILY_GOAL_CHOICES, LEARNER_NAME_MAX } from "./storage";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
/** How long today's star celebrates once the goal is met. */
const CELEBRATE_MS = 2400;
/** How often an open page checks whether the local day has changed. */
const DAY_CHECK_MS = 60 * 1000;
const minutes = (seconds: number) => Math.floor(seconds / 60);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function Star() {
  return (
    <svg className="practice-star" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.5l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17l-5.9 3.3 1.3-6.5-4.9-4.5 6.6-.8z" />
    </svg>
  );
}

/** A week's stamp: grey until every day of the week earned its star. */
function Stamp() {
  return (
    <img
      className="practice-stamp-mark"
      src={`${import.meta.env.BASE_URL}bearpaws.svg?v=3`}
      alt=""
      aria-hidden="true"
    />
  );
}

/** Today's progress toward the goal, as a ring around the date. */
function Ring({ seconds, goal }: { seconds: number; goal: number }) {
  const length = 2 * Math.PI * 15;
  const done = Math.min(seconds / goal, 1);
  return (
    <svg className="practice-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="15" />
      <circle
        className="practice-ring-done"
        cx="18"
        cy="18"
        r="15"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - done)}
      />
    </svg>
  );
}

/**
 * The local day that `today` reports. The component renders again when the
 * day changes, even while nothing else does, such as across midnight with
 * playback paused or the tab hidden.
 */
export function useLocalDay(today: () => string) {
  const [, setDay] = useState(today);
  useEffect(() => {
    const check = () => setDay(today());
    const timer = setInterval(check, DAY_CHECK_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [today]);
  return today();
}

/**
 * A browsable month of practice: a star on each day with at least the daily goal, a
 * dot on days with some practice, and a ring filling up for today. Each week
 * ends with a stamp, coloured in once all seven days have their star. Today's
 * star pops when the goal is met while the studio is open. The learner's name
 * and the goal can be edited here.
 */
export const PracticeCalendar = memo(function PracticeCalendar({
  totals,
  today,
  learnerName,
  goalMinutes,
  onLearnerName,
  onGoalMinutes,
}: {
  /** Seconds practiced on each day, YYYY-MM-DD. */
  totals: ReadonlyMap<string, number>;
  today: string;
  learnerName: string;
  goalMinutes: number;
  onLearnerName: (name: string) => void;
  onGoalMinutes: (minutes: number) => void;
}) {
  const goal = goalMinutes * 60;
  const name = learnerName.trim();
  const todaySeconds = totals.get(today) ?? 0;
  const [celebrating, setCelebrating] = useState(false);
  const [editing, setEditing] = useState(false);
  // null follows today's month across midnight; a browsed month stays put.
  const [viewedMonth, setViewedMonth] = useState<string | null>(null);
  const before = useRef(todaySeconds);
  useEffect(() => {
    // Only practice earns the celebration, not a goal lowered past today.
    if (before.current < goal && todaySeconds >= goal) setCelebrating(true);
    before.current = todaySeconds;
  }, [todaySeconds]);
  useEffect(() => {
    if (!celebrating) return;
    const timer = setTimeout(() => setCelebrating(false), CELEBRATE_MS);
    return () => clearTimeout(timer);
  }, [celebrating]);

  const currentMonth = today.slice(0, 7);
  const calendarMonth = viewedMonth ?? currentMonth;
  const [year, month] = calendarMonth.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const monthName = first.toLocaleDateString("en-US", { month: "long" });
  const monthLabel = `${monthName} ${year}`;
  const moveMonth = (offset: number) => {
    const next = localDay(new Date(year, month - 1 + offset, 1)).slice(0, 7);
    setViewedMonth(next === currentMonth ? null : next);
  };
  // Weeks start on Monday.
  const blanks = (first.getDay() + 6) % 7;
  const dates = Array.from(
    { length: new Date(year, month, 0).getDate() },
    (_, i) => addDays(`${calendarMonth}-01`, i),
  );
  // One row per week, Monday to Sunday; a week can reach into the months
  // around this one, and its stamp counts those days too.
  const weeks = Array.from(
    { length: Math.ceil((blanks + dates.length) / 7) },
    (_, row) => addDays(dates[0], row * 7 - blanks),
  );
  const run = streak(totals, today, goal);
  const done = todaySeconds >= goal;

  const dayCell = (day: string) => {
    const seconds = totals.get(day) ?? 0;
    const date = Number(day.slice(8));
    const outsideMonth = day.slice(0, 7) !== calendarMonth;
    const dateLabel = outsideMonth
      ? new Date(`${day}T12:00:00`).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          ...(day.slice(0, 4) !== String(year) && { year: "numeric" }),
        })
      : `${monthName} ${date}`;
    const isToday = day === today;
    const met = seconds >= goal;
    const state = met
      ? "done"
      : isToday
        ? "today"
        : day > today
          ? "future"
          : seconds > 0
            ? "some"
            : "";
    const label = `${dateLabel}${isToday ? ", today" : ""}: ${
      met
        ? `${plural(minutes(seconds), "minute")}, star earned`
        : isToday
          ? `${minutes(seconds)} of ${goalMinutes} minutes`
          : day > today
            ? "coming up"
            : seconds > 0
              ? plural(minutes(seconds), "minute")
              : "no practice"
    }`;
    return (
      <span
        key={day}
        role="listitem"
        aria-label={label}
        aria-current={isToday ? "date" : undefined}
        title={label}
        className={`practice-day ${outsideMonth ? "outside-month" : ""} ${state} ${isToday ? "is-today" : ""} ${
          isToday && celebrating ? "celebrate" : ""
        }`}
      >
        {met ? <Star /> : date}
        {isToday && !met && <Ring seconds={seconds} goal={goal} />}
        {isToday &&
          celebrating &&
          Array.from({ length: 8 }, (_, i) => (
            <i
              key={i}
              className="practice-spark"
              style={
                {
                  "--angle": `${i * 45}deg`,
                } as CSSProperties
              }
            />
          ))}
      </span>
    );
  };

  return (
    <section
      className={`practice-calendar ${name ? "has-learner" : ""}`}
      aria-labelledby="practice-month"
    >
      {name && <p className="practice-learner">{name}’s practice</p>}
      <div className="practice-calendar-head">
        <div
          className="practice-month-nav"
          role="group"
          aria-label="Calendar months"
        >
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => moveMonth(-1)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m12 5-5 5 5 5" />
            </svg>
          </button>
          <strong id="practice-month" aria-live="polite" aria-atomic="true">
            {monthLabel}
          </strong>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => moveMonth(1)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="m8 5 5 5-5 5" />
            </svg>
          </button>
        </div>
        {run > 0 && (
          <span className="practice-streak">
            <Star />
            {run}-day streak
          </span>
        )}
        <button
          type="button"
          className="practice-current-month"
          disabled={calendarMonth === currentMonth}
          onClick={() => setViewedMonth(null)}
        >
          Today
        </button>
      </div>
      <div className="practice-days" role="list">
        {WEEKDAYS.map((name, i) => (
          <span key={i} className="practice-weekday" aria-hidden="true">
            {name}
          </span>
        ))}
        <span aria-hidden="true" />
        {weeks.map((monday) => {
          const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
          const stars = week.filter((d) => (totals.get(d) ?? 0) >= goal).length;
          const earned = stars === 7;
          const stampLabel = `Week of ${monthName} ${Number(
            week.find((d) => d.slice(0, 7) === calendarMonth)!.slice(8),
          )}: ${earned ? "stamp earned" : `${stars} of 7 stars`}`;
          return [
            ...week.map(dayCell),
            <span
              key={`stamp-${monday}`}
              role="listitem"
              aria-label={stampLabel}
              title={stampLabel}
              className={`practice-stamp ${earned ? "earned" : ""}`}
            >
              <Stamp />
            </span>,
          ];
        })}
      </div>
      <div className="practice-foot">
        <p className="practice-today">
          {done ? (
            `Today's star earned. Great job${name ? `, ${name}` : ""}!`
          ) : todaySeconds > 0 ? (
            `Today: ${minutes(todaySeconds)} of ${goalMinutes} minutes`
          ) : (
            <>
              Play <strong>{plural(goalMinutes, "minute")}</strong> today to
              earn a star.
            </>
          )}
        </p>
        <button
          type="button"
          className="practice-edit"
          aria-expanded={editing}
          aria-controls="practice-profile"
          onClick={() => setEditing(!editing)}
        >
          {editing ? "Done" : "Edit"}
        </button>
      </div>
      {editing && (
        <div className="practice-profile" id="practice-profile">
          <label>
            Name
            <input
              value={learnerName}
              maxLength={LEARNER_NAME_MAX}
              placeholder="Who is practicing?"
              autoComplete="off"
              onChange={(e) => onLearnerName(e.target.value)}
            />
          </label>
          <label>
            Daily goal
            <select
              value={goalMinutes}
              onChange={(e) => onGoalMinutes(Number(e.target.value))}
            >
              {DAILY_GOAL_CHOICES.map((choice) => (
                <option key={choice} value={choice}>
                  {choice} minutes
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p className="sr-only" role="status">
        {celebrating ? `Today's star earned${name ? `, ${name}` : ""}!` : ""}
      </p>
    </section>
  );
});
