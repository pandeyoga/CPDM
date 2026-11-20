import { createHash } from "node:crypto";
import { applyCorrections, buildLedger, type Correction, type LedgerOptions } from "../domain/ledger.js";
import { msgEskalasi, msgInputTidakValid, teksStatus } from "../domain/messages.js";
import { expectedOmzet, hariStreakDiBawah, summarizeHosts, toKreditRows, type HostSummary } from "../domain/rekap.js";
import { computeTargets, targetHarianRows, type HostTarget, type TargetInputs } from "../domain/targets.js";
import { addDays, toJakartaHM } from "../domain/time.js";
import type { LedgerEntry, Report, Settings } from "../domain/types.js";
import type { Db, OutboxOp } from "../infra/db.js";
import { toSesiRows, type Invalid, type KondisiRow, type KoreksiRow, type SheetOp, type SheetsGateway } from "../infra/sheets.js";

/*
 * Refresh: baca input owner, terapkan koreksi dan atribusi yang disetujui, hitung ledger, target, dan rekap, lalu
 * antrekan tulisan ke Sheets lewat db.outbox. Angka dashboard tidak pernah ditulis sebagai nilai (rumus Task 6b);
 * yang ditulis hanya tabel fakta (Data Kredit, Target Harian), log (Sesi Live, Koreksi & Atribusi, Log Bot) dan
 * kolom kondisi bot (Butuh/hari kerja, Disiplin, Status).
 *
 * Tabel yang ditulis ulang (Data Kredit per bulan, Target Harian per bulan, Kondisi) diberi versi = hash isinya di
 * kv `versi:<kunci>`: hanya diantrekan kalau berubah, dan runner antrean melewati operasi yang versinya sudah
 * digantikan (operasi lama yang gagal lalu dicoba ulang tidak menimpa data yang lebih baru).
 */

export type Atribusi = Map<string, Array<{ host: string; share: number }>>;
export interface JadwalRow { date: string; host: string; mulai: string; selesai: string }

/** Input owner dari spreadsheet (disalin di memori dan db supaya bot tetap jalan saat Sheets gagal dibaca). */
export interface InputOwner {
  settings: Settings;
  koreksi: Correction[];
  atribusi: Atribusi;
  izin: Array<{ host: string; date: string }>;
  gangguan: Array<{ host: string; date: string; menit: number }>;
  tanpaLive: string[];
  /** null bila Jadwal aktif = TIDAK. */
  jadwal: JadwalRow[] | null;
}

export type RefreshGateway = Pick<
  SheetsGateway,
  "readSettings" | "readKoreksiKeputusan" | "readAtribusi" | "readKehadiran" | "readGangguan" | "readKalenderLive" | "readJadwal"
>;

export interface RefreshDeps {
  db: Db;
  gateway: RefreshGateway;
  now: () => Date;
  /** Penampung onInvalid SheetsGateway (diisi saat membaca); dikuras setiap refresh. */
  invalid: Invalid[];
}

export interface RefreshResult {
  summaries: HostSummary[];
  eskalasiBaru: string[];
  /** Pesan pribadi untuk owner (eskalasi, input owner tak valid); dikirim pemanggil lewat sendCapped. */
  pesanOwner: string[];
  input: InputOwner;
  /** Ledger bulan `today` (jendela db.reports(bulan), termasuk hari terakhir bulan lalu). */
  ledger: LedgerEntry[];
}

const STREAK_ESKALASI = 3;
const KV_INVALID = "invalidAktif";

export async function bacaInputOwner(gateway: RefreshGateway): Promise<InputOwner> {
  const settings = await gateway.readSettings();
  const [koreksi, atribusi, izin, gangguan, tanpaLive, jadwal] = await Promise.all([
    gateway.readKoreksiKeputusan(), gateway.readAtribusi(settings.hosts), gateway.readKehadiran(), gateway.readGangguan(),
    gateway.readKalenderLive(), settings.jadwalAktif ? gateway.readJadwal() : Promise.resolve(null),
  ]);
  return { settings, koreksi, atribusi, izin, gangguan, tanpaLive, jadwal };
}

/**
 * `cadangan`: input owner terakhir yang diketahui; dipakai (dengan log) kalau spreadsheet gagal dibaca.
 * Tanpa cadangan, kegagalan membaca dilempar.
 */
export async function refresh(deps: RefreshDeps, today: string, cadangan?: InputOwner | null): Promise<RefreshResult> {
  deps.invalid.splice(0); // sisa refresh yang gagal di tengah jalan; dibaca ulang di bawah
  let input: InputOwner;
  let pesanInvalid: string[] = [];
  try {
    input = await bacaInputOwner(deps.gateway);
    pesanInvalid = laporInvalid(deps, deps.invalid.splice(0));
  } catch (e) {
    if (!cadangan) throw e;
    console.error(`refresh: input owner tidak terbaca, memakai salinan terakhir: ${pesanError(e)}`);
    input = cadangan;
  }
  const hasil = hitungRefresh(deps, input, today);
  return { ...hasil, pesanOwner: [...hasil.pesanOwner, ...pesanInvalid] };
}

function hitungRefresh(deps: Pick<RefreshDeps, "db" | "now">, input: InputOwner, today: string): RefreshResult {
  const { db } = deps;
  const bulan = today.slice(0, 7);
  const bulanLalu = addDays(`${bulan}-01`, -1).slice(0, 7);
  const reports = applyCorrections(db.reports(bulan), input.koreksi);
  const reportsLalu = applyCorrections(db.reports(bulanLalu), input.koreksi);
  const ledger = bangunLedger(reports, input);
  const ledgerLalu = bangunLedger(reportsLalu, input);
  const inp = targetInputs(input, bulan);
  const inpLalu = targetInputs(input, bulanLalu);
  const targets = computeTargets(inp);
  const targetsLalu = computeTargets(inpLalu);

  // Entri tiap bulan diambil dari ledger bulannya sendiri (konteks hari sebelumnya lengkap, R14).
  const entriBulan = ledger.filter((e) => e.date.slice(0, 7) === bulan);
  const entriLalu = ledgerLalu.filter((e) => e.date.slice(0, 7) === bulanLalu);
  // Urut waktu: siaran baru lewat tengah malam bisa bertanggal bulan baru sebelum ekor siaran semalam (bulan lalu).
  const entri = [...entriLalu, ...entriBulan].sort((a, b) => a.at.getTime() - b.at.getTime());

  // Laporan yang masih menunggu ekstraksi bisa mengisi celah; masalah baru dicatat setelah antrean itu kosong.
  if (db.pendingExtract.all().length === 0) catatMasalah(db, entri, deps.now());
  const summaries = summarizeHosts(ledger, ledgerLalu, targets, inp, today, db.problemCounts(bulan));

  antreKredit(db, bulanLalu, entriLalu, ledgerLalu);
  antreKredit(db, bulan, entriBulan, ledger);
  antreBerversi(db, `targetHarian:${bulanLalu}`, { type: "writeTargetHarian", month: bulanLalu, rows: targetHarianRows(targetsLalu, inpLalu) });
  antreBerversi(db, `targetHarian:${bulan}`, { type: "writeTargetHarian", month: bulan, rows: targetHarianRows(targets, inp) });
  antreBerversi(db, "kondisi", { type: "writeKondisi", rows: kondisi(summaries, input.settings) });
  antreSesi(db, entri, [...reportsLalu, ...reports]);

  const eskalasiBaru = eskalasi(deps, input.settings, summaries, ledger, targets, inp, today);
  return { summaries, eskalasiBaru, pesanOwner: eskalasiBaru.length > 0 ? [msgEskalasi(eskalasiBaru)] : [], input, ledger };
}

function bangunLedger(reports: Report[], input: InputOwner): LedgerEntry[] {
  const { settings, jadwal, atribusi } = input;
  const opts: LedgerOptions = { maxGapMenit: settings.maxGapMenit, liveMulai: settings.liveMulai, attributions: atribusi };
  if (jadwal) opts.onShift = (host, date) => jadwal.some((r) => r.host === host && r.date === date);
  return buildLedger(reports, opts);
}

function targetInputs(input: InputOwner, month: string): TargetInputs {
  const { settings } = input;
  const menit = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const durasi = menit(settings.liveSelesai) - menit(settings.liveMulai);
  return {
    month, teamTarget: settings.teamTarget[month] ?? 0, hosts: settings.hosts, tanpaLive: input.tanpaLive, izin: input.izin,
    gangguan: input.gangguan, jadwal: input.jadwal, jamLive: (durasi > 0 ? durasi : durasi + 1440) / 60,
  };
}

/* ---------- Masalah laporan (R5) ---------- */

/** Entri sebelum `i` di platform yang sama dari pesan lain, terbaru dulu, yang memenuhi `cocok`. */
function sebelum(es: LedgerEntry[], i: number, cocok: (x: LedgerEntry) => boolean = () => true): LedgerEntry | undefined {
  const e = es[i]!;
  for (let j = i - 1; j >= 0; j--) {
    const x = es[j]!;
    if (x.platform === e.platform && x.messageId !== e.messageId && cocok(x)) return x;
  }
  return undefined;
}

/**
 * Pihak yang lalai: siaran belum lengkap → host laporan terakhir sebelum reset; belum teratribusi → pelapor
 * sebelumnya (laporan yang membuka interval; dialah yang melewatkan laporan pergantian). null bila tidak ada.
 */
function pelaku(es: LedgerEntry[], i: number, kind: "belum_lengkap" | "belum_teratribusi"): string | null {
  const e = es[i]!;
  const x = kind === "belum_lengkap" ? sebelum(es, i) : sebelum(es, i, (p) => p.at.getTime() === e.intervalStart.getTime());
  return x?.host ?? null;
}

function catatMasalah(db: Db, es: LedgerEntry[], now: Date): void {
  es.forEach((e, i) => {
    if (e.flags.includes("siaran_belum_lengkap")) db.logProblem(e.messageId, pelaku(es, i, "belum_lengkap"), e.date, "belum_lengkap");
    if (!e.flags.includes("belum_teratribusi")) return;
    const lalai = pelaku(es, i, "belum_teratribusi");
    db.logProblem(e.messageId, lalai, e.date, "belum_teratribusi");
    // Satu baris atribusi per laporan-platform di Koreksi & Atribusi; owner mengisi kolom Atribusi lalu Setujui.
    const k = `atribusi:${e.messageId}|${e.platform}`;
    if (db.getKv(k) !== null) return;
    const row: KoreksiRow = {
      tanggal: e.date, host: e.host,
      masalah: "Belum teratribusi (laporan pergantian terlewat). Isi kolom Atribusi, mis. \"Brando 50, Vanna 50\".",
      angkaBot: e.credit.omzet ?? "", usulan: lalai && lalai !== e.host ? `${lalai} 50, ${e.host} 50` : e.host,
      jenis: "atribusi", messageId: e.messageId, platform: e.platform,
    };
    db.outbox.push({ type: "appendKoreksi", row });
    db.setKv(k, now.toISOString());
  });
}

/** Rekap owner untuk satu tanggal: hitungan siaran belum lengkap / belum teratribusi dan host yang lalai. */
export function masalahHari(ledger: LedgerEntry[], date: string): { bolong: string[]; belumLengkap: number; belumTeratribusi: number } {
  const bolong = new Set<string>();
  let belumLengkap = 0;
  let belumTeratribusi = 0;
  ledger.forEach((e, i) => {
    if (e.date !== date) return;
    if (e.flags.includes("siaran_belum_lengkap")) belumLengkap++;
    if (!e.flags.includes("belum_teratribusi")) return;
    belumTeratribusi++;
    const lalai = pelaku(ledger, i, "belum_teratribusi");
    if (lalai) bolong.add(lalai);
  });
  return { bolong: [...bolong], belumLengkap, belumTeratribusi };
}

/* ---------- Antrean tulisan ---------- */

export type OpBerversi = OutboxOp & { versi?: { kunci: string; hash: string } };

function antreBerversi(db: Db, kunci: string, op: SheetOp): void {
  const k = `versi:${kunci}`;
  const hash = createHash("sha256").update(JSON.stringify(op)).digest("hex");
  if (db.getKv(k) === hash) return;
  db.setKv(k, hash);
  db.outbox.push({ ...op, versi: { kunci: k, hash } });
}

/** Operasi tabel yang sudah digantikan versi lebih baru (dilewati runner antrean). */
export function opUsang(db: Db, op: OpBerversi): boolean {
  return op.versi !== undefined && db.getKv(op.versi.kunci) !== op.versi.hash;
}

export function catatTerapan(db: Db, op: OpBerversi): void {
  if (op.versi) db.setKv(`${op.versi.kunci}:terapan`, op.versi.hash);
}

/** Versi terbaru tabel `kunci` (mis. "kredit:2026-11") sudah diterapkan ke spreadsheet. */
export function sinkron(db: Db, kunci: string): boolean {
  return db.getKv(`versi:${kunci}`) === db.getKv(`versi:${kunci}:terapan`);
}

/** Data Kredit satu bulan: semua entri bulan itu (upsert messageId|platform|host|jam); hanya kalau berubah. */
function antreKredit(db: Db, bulan: string, entri: LedgerEntry[], ledger: LedgerEntry[]): void {
  if (entri.length === 0) return;
  antreBerversi(db, `kredit:${bulan}`, { type: "upsertKredit", rows: toKreditRows(entri, expectedOmzet(ledger, bulan)) });
}

/** Kondisi per baris DAFTAR_HOST (urutan host di Pengaturan, maksimal 10). */
function kondisi(summaries: HostSummary[], settings: Settings): KondisiRow[] {
  return settings.hosts.slice(0, 10).map((h) => {
    const s = summaries.find((x) => x.host === h.name);
    return { host: h.name, butuhPerHariKerja: s?.butuhPerHariKerja ?? null, disiplin: s?.disiplin ?? null, status: s ? teksStatus(s) : "" };
  });
}

/** Sesi Live: entri yang belum ditulis, setelah buktinya terunggah (kv bukti:<messageId>; "" = berkas tidak ada). */
function antreSesi(db: Db, entri: LedgerEntry[], reports: Report[]): void {
  const sudah = (e: LedgerEntry): boolean => db.getKv(`sesi:${e.messageId}|${e.platform}`) !== null;
  const bukti = new Map<string, string>();
  const siap = entri.filter((e) => {
    const link = db.getKv(`bukti:${e.messageId}`);
    if (sudah(e) || link === null) return false;
    bukti.set(e.messageId, link);
    return true;
  });
  if (siap.length === 0) return;
  const angkaLayar = new Map<string, number>();
  for (const r of reports) if (r.reading.omzet) angkaLayar.set(`${r.messageId}|${r.reading.platform}`, r.reading.omzet.value);
  db.outbox.push({ type: "appendSesi", rows: toSesiRows(siap, { angkaLayar, bukti }) });
  for (const e of siap) db.setKv(`sesi:${e.messageId}|${e.platform}`, "1");
}

/* ---------- Eskalasi dan input tak valid ---------- */

/**
 * Host dengan streak ≥ 3 yang awal streak-nya belum pernah dilaporkan (kv eskalasi:<host> = tanggal awal streak).
 * Sebelum jam update pagi tidak dicatat, supaya owner tidak dikirimi pesan tengah malam.
 */
function eskalasi(
  deps: Pick<RefreshDeps, "db" | "now">, settings: Settings, summaries: HostSummary[], ledger: LedgerEntry[],
  targets: Record<string, HostTarget>, inp: TargetInputs, today: string,
): string[] {
  const { db } = deps;
  if (toJakartaHM(deps.now()) < settings.jamPagi) return [];
  const baru: string[] = [];
  for (const s of summaries) {
    const t = targets[s.host];
    if (s.streakDiBawah < STREAK_ESKALASI || !t) continue;
    const mulai = hariStreakDiBawah(s.host, ledger, t, inp, today).at(-1);
    const k = `eskalasi:${s.host}`;
    if (!mulai || db.getKv(k) === mulai) continue;
    db.setKv(k, mulai);
    baru.push(s.host);
  }
  return baru;
}

/** Baris Log Bot per item baru dan satu pesan owner; item yang masih sama dengan refresh sebelumnya tidak diulang. */
function laporInvalid(deps: Pick<RefreshDeps, "db" | "now">, items: Invalid[]): string[] {
  const { db } = deps;
  const kunci = (i: Invalid): string => `${i.tab}|${i.row}|${i.reason}`;
  const sekarang = [...new Map(items.map((i) => [kunci(i), i])).values()];
  let lama: string[] = [];
  try {
    lama = JSON.parse(db.getKv(KV_INVALID) ?? "[]") as string[];
  } catch {
    lama = [];
  }
  const baru = sekarang.filter((i) => !lama.includes(kunci(i)));
  db.setKv(KV_INVALID, JSON.stringify(sekarang.map(kunci)));
  for (const i of baru) {
    db.outbox.push({ type: "appendLog", at: deps.now(), level: "WARN", pesan: `Input owner tidak valid — ${i.tab} baris ${i.row}: ${i.reason}` });
  }
  return baru.length > 0 ? [msgInputTidakValid(baru)] : [];
}

const pesanError = (e: unknown): string => (e instanceof Error ? e.message : String(e));
