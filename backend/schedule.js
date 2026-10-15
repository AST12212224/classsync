// Time helpers and the clash rule, shared by live bookings and the timetable.
// All times are India time (Asia/Kolkata), whatever the server's own clock is set to.
const ZONE = 'Asia/Kolkata';
const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
});
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function now() {
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, day: WEEKDAY[p.weekday] };
}

// College hours, with times chosen in 15-minute steps.
const OPEN = '08:00', CLOSE = '18:00', STEP = 15;
const TIME = /^([01]\d|2[0-3]):(00|15|30|45)$/;
const FIRST_SLOT = 8, LAST_SLOT = 17; // timetable slots are whole hours: 08:00-09:00 ... 17:00-18:00

// 15-minute blocks a from-to range covers: 09:00-09:30 covers blocks 36 and 37.
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const blocks = (from, to) => {
  const a = Math.floor(mins(from) / STEP), b = Math.ceil(mins(to) / STEP);
  return Array.from({ length: Math.max(b - a, 0) }, (_, i) => a + i);
};
const slotBlocks = (h) => blocks(`${String(h).padStart(2, '0')}:00`, `${String(h + 1).padStart(2, '0')}:00`);

// Conflict rule from the proposal. A class is the vector (room, time block, floor).
// Two classes clash when A x B = 0 (parallel) and |A|^2 = |B|^2 (equal length).
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const len2 = (a) => a[0]**2 + a[1]**2 + a[2]**2;
const vectors = (room, floor, list) => list.map((t) => [room, t, floor]);
const clashes = (A, B) => A.some((a) => B.some((b) => cross(a, b).every((c) => c === 0) && len2(a) === len2(b)));

module.exports = { ZONE, now, OPEN, CLOSE, TIME, FIRST_SLOT, LAST_SLOT, blocks, slotBlocks, vectors, clashes };
