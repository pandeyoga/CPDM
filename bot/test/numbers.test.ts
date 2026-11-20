import { describe, it, expect } from "vitest";
import { parseNum, parseDurasi } from "../src/domain/numbers.js";

describe("parseNum", () => {
  it("parses suffixes as rounded", () => {
    expect(parseNum("Rp578rb")).toEqual({ value: 578000, rounded: true });
    expect(parseNum("Rp1,2jt")).toEqual({ value: 1200000, rounded: true });
    expect(parseNum("23,7K")).toEqual({ value: 23700, rounded: true });
    expect(parseNum("578 RB")).toEqual({ value: 578000, rounded: true });
    expect(parseNum("1,5m")).toEqual({ value: 1500000, rounded: true });
  });
  it("parses exact numbers", () => {
    expect(parseNum("1.317.034")).toEqual({ value: 1317034, rounded: false });
    expect(parseNum("Rp1.317.034")).toEqual({ value: 1317034, rounded: false });
    expect(parseNum("Rp 1.317.034")).toEqual({ value: 1317034, rounded: false });
    expect(parseNum("952")).toEqual({ value: 952, rounded: false });
  });
  it("returns null for other currencies and junk", () => {
    expect(parseNum("$0.02")).toBeNull();
    expect(parseNum("US$5")).toBeNull();
    expect(parseNum("")).toBeNull();
    expect(parseNum("abc")).toBeNull();
    expect(parseNum("Rp")).toBeNull();
    expect(parseNum("1.2.x")).toBeNull();
  });
});

describe("parseDurasi", () => {
  it("parses HH:MM:SS and MM:SS", () => {
    expect(parseDurasi("11:00:32")).toBe(39632);
    expect(parseDurasi("00:00:38")).toBe(38);
    expect(parseDurasi("05:10")).toBe(310);
  });
  it("returns null otherwise", () => {
    expect(parseDurasi("")).toBeNull();
    expect(parseDurasi("abc")).toBeNull();
    expect(parseDurasi("1:2:3:4")).toBeNull();
    expect(parseDurasi("11:xx:32")).toBeNull();
  });
});
