import { describe, expect, it } from "vitest";
import { parseAuthInput } from "../scripts/google-auth-input.js";

const S = "abc123state";

describe("parseAuthInput", () => {
  it("mengambil code dari URL lengkap", () => {
    expect(parseAuthInput(`http://127.0.0.1:41234/?state=${S}&code=4/0AbCd&scope=x`, S)).toEqual({ ok: true, code: "4/0AbCd" });
  });
  it("menerima kode saja", () => {
    expect(parseAuthInput("  4/0AbCdEf  ", S)).toEqual({ ok: true, code: "4/0AbCdEf" });
  });
  it("menolak state yang tidak cocok", () => {
    const r = parseAuthInput("http://127.0.0.1:1/?state=lain&code=4/0A", S);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/state/);
  });
  it("menolak URL tanpa code", () => {
    const r = parseAuthInput(`http://127.0.0.1:1/?state=${S}`, S);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/code/);
  });
  it("men-decode code yang URL-encoded (di URL maupun kode saja)", () => {
    expect(parseAuthInput(`http://127.0.0.1:1/?state=${S}&code=4%2F0AbCd`, S)).toEqual({ ok: true, code: "4/0AbCd" });
    expect(parseAuthInput("4%2F0AbCd", S)).toEqual({ ok: true, code: "4/0AbCd" });
  });
  it("membaca potongan query tanpa '?' (state=…&code=…&scope=…)", () => {
    expect(parseAuthInput(`state=${S}&code=4/0AbCd&scope=x`, S)).toEqual({ ok: true, code: "4/0AbCd" });
    expect(parseAuthInput(`code=4%2F0AbCd&scope=https://x`, S)).toEqual({ ok: true, code: "4/0AbCd" });
    const r = parseAuthInput(`code=4/0A&state=lain`, S);
    expect(r.ok).toBe(false);
  });
  it("menolak masukan kosong dan error dari Google", () => {
    expect(parseAuthInput("   ", S).ok).toBe(false);
    expect(parseAuthInput(`http://127.0.0.1:1/?error=access_denied&state=${S}`, S).ok).toBe(false);
  });
});
