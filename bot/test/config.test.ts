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
};

describe("loadConfig", () => {
  it("melempar error yang menyebut variabel yang hilang", () => {
    const { LIVE_GROUP_ID: _omit, ...env } = full;
    expect(() => loadConfig(env)).toThrow(/LIVE_GROUP_ID/);
  });

  it("menyebut semua variabel yang hilang", () => {
    expect(() => loadConfig({})).toThrow(/WAHA_URL[\s\S]*DB_PATH/);
  });

  it("mengembalikan config bertipe; JADWAL_SPREADSHEET_ID opsional", () => {
    const c = loadConfig(full);
    expect(c.LIVE_GROUP_ID).toBe("123@g.us");
    expect(c.DB_PATH).toBe("data/bot.db");
    expect(c.JADWAL_SPREADSHEET_ID).toBeUndefined();
    expect(loadConfig({ ...full, JADWAL_SPREADSHEET_ID: "j" }).JADWAL_SPREADSHEET_ID).toBe("j");
  });
});
