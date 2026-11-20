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
  /** Kunci WHATSAPP_HOOK_HMAC_KEY di WAHA; webhook tanpa X-Webhook-Hmac yang cocok ditolak 401. */
  WAHA_HMAC_KEY: nonEmpty,
  /** Folder data bot (bukti lokal); wajib, tanpa bawaan. */
  DATA_DIR: nonEmpty,
  JADWAL_SPREADSHEET_ID: z.string().min(1).optional(),
  PORT: z.string().regex(/^\d{1,5}$/).transform(Number).pipe(z.number().int().min(1).max(65_535)).default(3000),
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
