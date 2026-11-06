import { describe, expect, it } from "vitest";
import { fill, quotable } from "../src/lib/text";
import { seededRand } from "../src/lib/rand";
import { COURSE_RECORD, PARS, rollStrokes, scoreName } from "../src/tools/tee_off";
import { quack256 } from "../src/tools/submit_suggestion";

describe("golf", () => {
  it("is a par-72, 18-hole course", () => {
    expect(PARS).toHaveLength(18);
    expect(PARS.reduce((a, b) => a + b, 0)).toBe(72);
  });

  it("never scores below 1, and only aces on par 3s", () => {
    const rand = seededRand(7);
    for (let i = 0; i < 20_000; i++) {
      const par = PARS[i % 18]!;
      const strokes = rollStrokes(par, rand);
      expect(strokes).toBeGreaterThanOrEqual(1);
      if (strokes === 1) expect(par).toBe(3);
    }
  });

  it("the course record is not in danger", () => {
    // Even a perfect round of birdies (par - 1 every hole) is 54. Only 18 aces would tie it.
    expect(PARS.reduce((a, p) => a + (p - 1), 0)).toBeGreaterThan(COURSE_RECORD);
  });

  it("names scores", () => {
    expect(scoreName(1, 3)).toBe("Hole in one");
    expect(scoreName(3, 4)).toBe("Birdie");
    expect(scoreName(4, 4)).toBe("Par");
    expect(scoreName(9, 4)).toBe("5 over par");
  });
});

describe("Quack-256", () => {
  it("produces only quacks", () => {
    const ciphertext = quack256(seededRand(1));
    expect(ciphertext.split(" ").every((w) => /quack|QUAAACK/i.test(w))).toBe(true);
  });
});

describe("quotable", () => {
  it("drops trailing sentence punctuation so quotes don't double up", () => {
    expect(fill('completed "{t}".', { t: quotable("Shipped v1.") })).toBe('completed "Shipped v1".');
    expect(quotable("Fixed it!!")).toBe("Fixed it");
    expect(quotable("Did it work?  ")).toBe("Did it work");
    expect(quotable("Wrapped up…")).toBe("Wrapped up");
  });

  it("leaves inner punctuation alone, and never returns an empty string", () => {
    expect(quotable("Bumped v1.2.3 to v1.2.4")).toBe("Bumped v1.2.3 to v1.2.4");
    expect(quotable("Refactored the Node.js build")).toBe("Refactored the Node.js build");
    expect(quotable("...")).toBe("...");
  });
});

describe("fill", () => {
  it("fills known placeholders, keeps unknown ones, and does not re-scan values", () => {
    expect(fill("{a} and {b}", { a: "{b}" })).toBe("{b} and {b}");
  });
});
