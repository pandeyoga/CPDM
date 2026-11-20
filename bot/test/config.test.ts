import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const full: NodeJS.ProcessEnv = {
  WAHA_URL: "http://localhost:3000",
  WAHA_API_KEY: "k",
  WAHA_SESSION: "default",
  LIVE_GROUP_ID: "123@g.us",
  ANTHROPIC_API_KEY: "sk-x",
  GOOGLE_CLIENT_ID: "cid",
  GOOGLE_CLIENT_SECRET: "cs",
  GOOGLE_REFRESH_TOKEN: "rt",
  LIVE_SPREADSHEET_ID: "sheet",
  BUKTI_FOLDER_ID: "folder",
  DB_PATH: "data/bot.db",
  WAHA_HMAC_KEY: "hmac",
  DATA_DIR: "/data",
};

describe("loadConfig", () => {
  it("melempar error yang menyebut variabel yang hilang", () => {
    const { LIVE_GROUP_ID: _omit, ...env } = full;
    expect(() => loadConfig(env)).toThrow(/LIVE_GROUP_ID/);
  });

  it("menyebut semua variabel yang hilang", () => {
    expect(() => loadConfig({})).toThrow(/WAHA_URL[\s\S]*DB_PATH[\s\S]*WAHA_HMAC_KEY[\s\S]*DATA_DIR/);
  });

  it("mengembalikan config bertipe; JADWAL_SPREADSHEET_ID opsional", () => {
    const c = loadConfig(full);
    expect(c.LIVE_GROUP_ID).toBe("123@g.us");
    expect(c.DB_PATH).toBe("data/bot.db");
    expect(c.JADWAL_SPREADSHEET_ID).toBeUndefined();
    expect(loadConfig({ ...full, JADWAL_SPREADSHEET_ID: "j" }).JADWAL_SPREADSHEET_ID).toBe("j");
  });
});

describe("loadConfig: server (Task 12)", () => {
  it("WAHA_HMAC_KEY dan DATA_DIR wajib (tanpa bawaan)", () => {
    const { WAHA_HMAC_KEY: _h, ...tanpaHmac } = full;
    expect(() => loadConfig(tanpaHmac)).toThrow(/WAHA_HMAC_KEY/);
    const { DATA_DIR: _d, ...tanpaData } = full;
    expect(() => loadConfig(tanpaData)).toThrow(/DATA_DIR/);
    expect(() => loadConfig({ ...full, DATA_DIR: "" })).toThrow(/DATA_DIR/);
  });
  it("PORT opsional, bawaan 3000", () => {
    expect(loadConfig(full).PORT).toBe(3000);
    expect(loadConfig({ ...full, PORT: "8080" }).PORT).toBe(8080);
    expect(() => loadConfig({ ...full, PORT: "abc" })).toThrow(/PORT/);
  });
});

describe("loadConfig: validasi format (M11)", () => {
  it("WAHA_URL harus URL http(s)", () => {
    for (const bad of ["localhost:3000", "bukan url", "ftp://waha:21"]) {
      expect(() => loadConfig({ ...full, WAHA_URL: bad }), bad).toThrow(/WAHA_URL/);
    }
    expect(loadConfig({ ...full, WAHA_URL: "http://waha:3000" }).WAHA_URL).toBe("http://waha:3000");
  });
  it("LIVE_GROUP_ID harus id grup (@g.us)", () => {
    for (const bad of ["628123456789@c.us", "120363000000000000", "@g.us"]) {
      expect(() => loadConfig({ ...full, LIVE_GROUP_ID: bad }), bad).toThrow(/LIVE_GROUP_ID/);
    }
  });
});
