// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PracticeCalendar, useLocalDay } from "../src/PracticeCalendar";

const goal = 5 * 60;
let root: Root;
let container: HTMLDivElement;
const day = (date: number) =>
  container.querySelector<HTMLElement>(
    `[aria-label^="October ${date}${date === 18 ? ", today" : ""}:"]`,
  )!;
async function render(
  totals: [string, number][],
  today = "2026-10-18",
  profile: Partial<Parameters<typeof PracticeCalendar>[0]> = {},
) {
  await act(async () =>
    root.render(
      <PracticeCalendar
        totals={new Map(totals)}
        today={today}
        learnerName=""
        goalMinutes={5}
        onLearnerName={() => {}}
        onGoalMinutes={() => {}}
        {...profile}
      />,
    ),
  );
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("practice calendar", () => {
  it("marks each day of the month by how much was practiced", async () => {
    await render([
      ["2026-10-14", 90],
      ["2026-10-15", goal],
      ["2026-10-16", goal + 120],
      ["2026-10-17", goal],
      ["2026-10-18", 185],
    ]);
    expect(container.querySelector("#practice-month")!.textContent).toBe(
      "October 2026",
    );
    // October 2026 starts on a Thursday; weeks start on Monday, and each of
    // its five weeks ends with a stamp.
    expect(container.querySelectorAll(".practice-day")).toHaveLength(31);
    expect(container.querySelectorAll(".practice-stamp")).toHaveLength(5);
    expect(day(16).className).toContain("done");
    expect(day(16).getAttribute("aria-label")).toBe(
      "October 16: 7 minutes, star earned",
    );
    expect(day(14).className).toContain("some");
    expect(day(14).getAttribute("aria-label")).toBe("October 14: 1 minute");
    expect(day(13).getAttribute("aria-label")).toBe("October 13: no practice");
    expect(day(19).className).toContain("future");
    expect(day(18).getAttribute("aria-label")).toBe(
      "October 18, today: 3 of 5 minutes",
    );
    expect(day(18).querySelector(".practice-ring")).not.toBeNull();
    expect(container.querySelector(".practice-streak")!.textContent).toBe(
      "3-day streak",
    );
    expect(container.querySelector(".practice-today")!.textContent).toBe(
      "Today: 3 of 5 minutes",
    );
  });

  it("browses across years without changing today's totals, and returns to today", async () => {
    const onLearnerName = vi.fn(),
      onGoalMinutes = vi.fn();
    await render(
      [
        ["2025-12-31", goal],
        ["2026-01-01", 120],
      ],
      "2026-01-01",
      { onLearnerName, onGoalMinutes },
    );
    const clickMonth = async (label: string) =>
      act(async () =>
        container
          .querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
          .click(),
      );
    await clickMonth("Previous month");
    expect(container.querySelector("#practice-month")!.textContent).toBe(
      "December 2025",
    );
    expect(container.querySelectorAll(".practice-day")).toHaveLength(31);
    expect(
      container.querySelector(
        '[aria-label="December 31: 5 minutes, star earned"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector(".is-today")).toBeNull();
    expect(container.querySelector(".practice-today")!.textContent).toBe(
      "Today: 2 of 5 minutes",
    );
    expect(container.querySelector(".practice-streak")!.textContent).toBe(
      "1-day streak",
    );
    await clickMonth("Next month");
    expect(container.querySelector("#practice-month")!.textContent).toBe(
      "January 2026",
    );
    expect(
      container.querySelector<HTMLButtonElement>(".practice-current-month")!
        .disabled,
    ).toBe(true);
    await clickMonth("Next month");
    expect(container.querySelector("#practice-month")!.textContent).toBe(
      "February 2026",
    );
    expect(container.querySelectorAll(".practice-day")).toHaveLength(28);
    expect(
      container.querySelector('[aria-label="February 1: coming up"]'),
    ).not.toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".practice-current-month")!
        .click(),
    );
    expect(container.querySelector("#practice-month")!.textContent).toBe(
      "January 2026",
    );
    expect(
      container.querySelector(".is-today")!.getAttribute("aria-label"),
    ).toBe("January 1, today: 2 of 5 minutes");
    expect(onLearnerName).not.toHaveBeenCalled();
    expect(onGoalMinutes).not.toHaveBeenCalled();
  });

  it("shows leap days and keeps a browsed month fixed across a change of day", async () => {
    await render([], "2028-01-31");
    await render([], "2028-02-01");
    expect(container.querySelector("#practice-month")!.textContent).toBe(
      "February 2028",
    );
    expect(container.querySelectorAll(".practice-day")).toHaveLength(29);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Previous month"]')!
        .click(),
    );
    await render([], "2028-03-01");
    expect(container.querySelector("#practice-month")!.textContent).toBe(
      "January 2028",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".practice-current-month")!
        .click(),
    );
    expect(container.querySelector("#practice-month")!.textContent).toBe(
      "March 2028",
    );
  });

  it("stamps a week once all seven days have their star, counting days in other months", async () => {
    const days = (from: string, count: number) =>
      Array.from({ length: count }, (_, i) => {
        const d = new Date(`${from}T12:00:00`);
        d.setDate(d.getDate() + i);
        return [d.toLocaleDateString("en-CA"), goal] as [string, number];
      });
    // The first row runs Monday 28 September to Sunday 4 October.
    await render([...days("2026-09-28", 7), ...days("2026-10-12", 6)]);
    const stamps = [...container.querySelectorAll(".practice-stamp")];
    expect(stamps.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Week of October 1: stamp earned",
      "Week of October 5: 0 of 7 stars",
      "Week of October 12: 6 of 7 stars",
      "Week of October 19: 0 of 7 stars",
      "Week of October 26: 0 of 7 stars",
    ]);
    expect(stamps.map((s) => s.classList.contains("earned"))).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    await render([...days("2026-10-12", 7)]);
    expect(
      container.querySelector(
        '[aria-label="Week of October 12: stamp earned"]',
      )!.className,
    ).toContain("earned");
  });

  it("asks for the day's goal with its minutes in bold", async () => {
    await render([]);
    expect(container.querySelector(".practice-today")!.textContent).toBe(
      "Play 5 minutes today to earn a star.",
    );
    expect(container.querySelector(".practice-today strong")!.textContent).toBe(
      "5 minutes",
    );
  });

  it("titles the calendar with the learner's name", async () => {
    await render([], "2026-10-18", { learnerName: "  George  " });
    expect(container.querySelector(".practice-learner")!.textContent).toBe(
      "George’s practice",
    );
    await render([], "2026-10-18", { learnerName: "" });
    expect(container.querySelector(".practice-learner")).toBeNull();
  });

  it("celebrates once when today reaches the goal", async () => {
    vi.useFakeTimers();
    await render([["2026-10-18", goal - 1]]);
    expect(container.querySelector(".celebrate")).toBeNull();
    expect(container.querySelector(".practice-streak")).toBeNull();
    await render([["2026-10-18", goal]]);
    expect(day(18).className).toContain("celebrate");
    expect(day(18).querySelectorAll(".practice-spark")).toHaveLength(8);
    expect(container.querySelector('[role="status"]')!.textContent).toBe(
      "Today's star earned!",
    );
    expect(container.querySelector(".practice-streak")!.textContent).toBe(
      "1-day streak",
    );
    // More practice keeps the celebration running its course, then it ends.
    await render([["2026-10-18", goal + 1]]);
    await act(async () => vi.advanceTimersByTime(2400));
    expect(container.querySelector(".celebrate")).toBeNull();
    expect(container.querySelector(".practice-today")!.textContent).toBe(
      "Today's star earned. Great job!",
    );
    // Already met when the studio opens: no celebration.
    act(() => root.unmount());
    root = createRoot(container);
    await render([["2026-10-18", goal]]);
    expect(container.querySelector(".celebrate")).toBeNull();
  });

  it("praises the learner by name and measures days against their goal", async () => {
    vi.useFakeTimers();
    const totals: [string, number][] = [
      ["2026-10-17", 10 * 60],
      ["2026-10-18", 9 * 60],
    ];
    await render(totals, "2026-10-18", {
      learnerName: " George ",
      goalMinutes: 10,
    });
    expect(day(17).className).toContain("done");
    expect(day(18).getAttribute("aria-label")).toBe(
      "October 18, today: 9 of 10 minutes",
    );
    expect(container.querySelector(".practice-streak")!.textContent).toBe(
      "1-day streak",
    );
    await render([...totals.slice(0, 1), ["2026-10-18", 10 * 60]], undefined, {
      learnerName: " George ",
      goalMinutes: 10,
    });
    expect(container.querySelector('[role="status"]')!.textContent).toBe(
      "Today's star earned, George!",
    );
    expect(container.querySelector(".practice-today")!.textContent).toBe(
      "Today's star earned. Great job, George!",
    );
  });

  it("does not celebrate a goal lowered below today's time", async () => {
    await render([["2026-10-18", 7 * 60]], "2026-10-18", { goalMinutes: 10 });
    await render([["2026-10-18", 7 * 60]], "2026-10-18", { goalMinutes: 5 });
    expect(day(18).className).toContain("done");
    expect(container.querySelector(".celebrate")).toBeNull();
  });

  it("edits the learner's name and daily goal", async () => {
    const onLearnerName = vi.fn(),
      onGoalMinutes = vi.fn();
    await render([], "2026-10-18", { onLearnerName, onGoalMinutes });
    const edit = container.querySelector<HTMLButtonElement>(".practice-edit")!;
    expect(edit.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".practice-profile")).toBeNull();
    await act(async () => edit.click());
    expect(edit.textContent).toBe("Done");
    const input = container.querySelector<HTMLInputElement>(
      ".practice-profile input",
    )!;
    const select = container.querySelector<HTMLSelectElement>(
      ".practice-profile select",
    )!;
    expect([...select.options].map((o) => o.value)).toEqual([
      "5",
      "10",
      "15",
      "20",
      "30",
    ]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "George");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onLearnerName).toHaveBeenLastCalledWith("George");
    await act(async () => {
      select.value = "20";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onGoalMinutes).toHaveBeenLastCalledWith(20);
    await act(async () => edit.click());
    expect(container.querySelector(".practice-profile")).toBeNull();
  });
});

describe("local day", () => {
  it("renders the new day after midnight while nothing else changes", async () => {
    vi.useFakeTimers();
    let current = "2026-10-18";
    const today = () => current;
    function Day() {
      return <span>{useLocalDay(today)}</span>;
    }
    await act(async () => root.render(<Day />));
    expect(container.textContent).toBe("2026-10-18");
    current = "2026-10-19";
    await act(async () => vi.advanceTimersByTime(60 * 1000));
    expect(container.textContent).toBe("2026-10-19");
    // Returning to a hidden tab checks at once.
    current = "2026-10-20";
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(container.textContent).toBe("2026-10-20");
  });
});
