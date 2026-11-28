// hacomono のシフトと予約から、オンライン面談を受けられる時間を作る（外部のライブラリに頼らない。Deno でも Node でも動く）
//
// 決まり（hacomono では、1人のプロ・コーチを「コーチA」「コーチB」の2人のスタッフとして登録している）
//   ・オンライン面談は毎時55分から20分（例：18:55〜19:15）。hacomono には「19:00 の枠」として入れる
//   ・その時間（19:00〜20:00）に、A・B のどちらかが出勤していて、予約も予定ブロックも入っていなければ受けられる
//   ・店舗の予約が2件（A・B とも埋まり）→ 受けられない。1件だけ → 残りの1人で受けられる
//   ・オンライン面談は1人のプロ・コーチにつき1時間1件まで（アプリ側の予約と合わせて、データベースで確かめる）
//   ・アプリが hacomono に入れたオンライン面談の予約は「店舗の予約」として数えない（同じ予約を二重に数えないため）

export type ScheduleShift = { instructor_id: number; date?: string; start_at?: string | null; end_at?: string | null };
export type ScheduleAssign = { reservation_id?: number | null; entity_type?: string | null; entity_id?: number | null; date?: string; start_at?: string | null; end_at?: string | null };
export type ChoiceSchedule = {
  date?: string;
  shift_instructor?: ScheduleShift[] | null;
  reservation_assign_instructor?: ScheduleAssign[] | null;
  shift_slot?: ScheduleAssign[] | null;
};
export type Coach = { staff_id: string; instructor_ids: number[] };
export type AvailabilityRow = { staff_id: string; slot_at: string; free_ids: number[] };

const HOUR = 3600_000;
const MIN = 60_000;

// hacomono の日時（「2026-12-01 19:00:00.000」・「2026-12-01T19:00:00+09:00」・時刻だけの「19:00」）を、日本時間として読む
export function parseJst(value: string | null | undefined, date?: string): number | null {
  if (!value) return null;
  let v = String(value).trim();
  if (/^\d{1,2}:\d{2}/.test(v)) {
    if (!date) return null;
    v = `${date.slice(0, 10)} ${v.length === 4 ? "0" + v : v}`;
  }
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const tz = m[4] ? (m[4] === "Z" ? "Z" : m[4].length === 5 ? `${m[4].slice(0, 3)}:${m[4].slice(3)}` : m[4]) : "+09:00";
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3] ?? "00"}${tz}`);
  return Number.isFinite(t) ? t : null;
}

const overlaps = (s: number, e: number, from: number, to: number) => s < to && e > from;

// 1日分のスケジュールから、プロ・コーチごとの「受けられる :55」の一覧を作る
//   date：営業日（yyyy-MM-dd）  ownReservationIds：アプリが入れたオンライン面談の hacomono 予約ID
export function availabilityForDay(date: string, schedule: ChoiceSchedule, coaches: Coach[], ownReservationIds: Set<number> = new Set()): AvailabilityRow[] {
  const shifts = schedule.shift_instructor ?? [];
  const busyList = [...(schedule.reservation_assign_instructor ?? []), ...(schedule.shift_slot ?? [])]
    .filter((a) => !a.entity_type || /instructor/i.test(a.entity_type))
    .filter((a) => !(a.reservation_id && ownReservationIds.has(Number(a.reservation_id))));
  const dayStart = parseJst(`${date} 00:00`)!;
  const rows: AvailabilityRow[] = [];
  for (const c of coaches) {
    const ids = [...new Set(c.instructor_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) continue;
    for (let h = 1; h < 24; h++) {   // 0時の枠（前日の23:55開始）は扱わない
      const from = dayStart + h * HOUR;
      const free: number[] = [];
      for (const id of ids) {
        // 出勤している：シフトがこの面談の時間（:00〜:20）をすべて含む
        const onShift = shifts.some((s) => {
          if (Number(s.instructor_id) !== id) return false;
          const st = parseJst(s.start_at, s.date ?? date);
          let en = parseJst(s.end_at, s.date ?? date);
          if (st === null || en === null) return false;
          if (en <= st) en += 24 * HOUR;   // 日をまたぐシフト
          return st <= from && en >= from + 20 * MIN;
        });
        if (!onShift) continue;
        // 予約・予定ブロックがこの1時間（:00〜次の:00）に入っていない
        const busy = busyList.some((a) => {
          if (Number(a.entity_id) !== id) return false;
          const st = parseJst(a.start_at, a.date ?? date);
          const en = parseJst(a.end_at, a.date ?? date);
          return st !== null && en !== null && overlaps(st, en, from, from + HOUR);
        });
        if (!busy) free.push(id);
      }
      if (free.length) rows.push({ staff_id: c.staff_id, slot_at: new Date(from - 5 * MIN).toISOString(), free_ids: free });
    }
  }
  return rows;
}
