import { describe, expect, it } from "vitest";
import { addDays, daysInMonth, jakartaDateTime, toJakartaDate, toJakartaHM } from "../src/domain/time.js";

describe("time (Asia/Jakarta)", () => {
  it("toJakartaDate melewati batas hari", () => {
    expect(toJakartaDate(new Date("2026-11-30T17:10:00Z"))).toBe("2026-12-01");
    expect(toJakartaDate(new Date("2026-11-30T16:59:00Z"))).toBe("2026-11-30");
  });
  it("toJakartaHM", () => {
    expect(toJakartaHM(new Date("2026-11-20T05:00:00Z"))).toBe("12:00");
    expect(toJakartaHM(new Date("2026-11-20T17:05:00Z"))).toBe("00:05");
  });
  it("jakartaDateTime", () => {
    expect(jakartaDateTime("2026-11-20", "09:00").toISOString()).toBe("2026-11-20T02:00:00.000Z");
    expect(jakartaDateTime("2026-11-20", "03:00").toISOString()).toBe("2026-11-19T20:00:00.000Z");
  });
  it("addDays", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-11-20", 0)).toBe("2026-11-20");
  });
  it("daysInMonth", () => {
    expect(daysInMonth("2026-11").length).toBe(30);
    expect(daysInMonth("2026-02").length).toBe(28);
    expect(daysInMonth("2028-02").length).toBe(29);
    expect(daysInMonth("2026-11")[0]).toBe("2026-11-01");
    expect(daysInMonth("2026-11")[29]).toBe("2026-11-30");
  });
});
