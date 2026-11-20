// Asia/Jakarta adalah UTC+7 tetap (tanpa DST).
const OFFSET_MS = 7 * 3600 * 1000;

const shifted = (d: Date): string => new Date(d.getTime() + OFFSET_MS).toISOString();

export function toJakartaDate(d: Date): string {
  return shifted(d).slice(0, 10);
}

export function toJakartaHM(d: Date): string {
  return shifted(d).slice(11, 16);
}

export function jakartaDateTime(date: string, hm: string): Date {
  return new Date(new Date(`${date}T${hm}:00.000Z`).getTime() - OFFSET_MS);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysInMonth(month: string): string[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}
