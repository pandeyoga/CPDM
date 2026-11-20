import { z } from "zod";

const nonEmpty = z.string().min(1);

const schema = z.object({
  WAHA_URL: nonEmpty,
  WAHA_API_KEY: nonEmpty,
  WAHA_SESSION: nonEmpty,
  LIVE_GROUP_ID: nonEmpty,
  ANTHROPIC_API_KEY: nonEmpty,
  GOOGLE_CLIENT_ID: nonEmpty,
  GOOGLE_CLIENT_SECRET: nonEmpty,
  GOOGLE_REFRESH_TOKEN: nonEmpty,
  LIVE_SPREADSHEET_ID: nonEmpty,
  BUKTI_FOLDER_ID: nonEmpty,
  DB_PATH: nonEmpty,
  JADWAL_SPREADSHEET_ID: z.string().min(1).optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`Variabel lingkungan hilang atau kosong: ${names.join(", ")}`);
  }
  return parsed.data;
}
