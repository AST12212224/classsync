require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { pg, redis } = require('./db');
const { limit, requestOtp, verifyOtp, requireAuth, logout } = require('./auth');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('Set JWT_SECRET to at least 32 random characters in .env');
}
const prod = process.env.NODE_ENV === 'production';
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY ? 1 : false);
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': prod ? [] : null } } }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', limit('api', Number(process.env.API_PER_MINUTE) || 600, 60, (r) => r.ip));

// ---------- Auth ----------
app.post('/api/auth/request-otp',
  limit('otp-ip', 60, 900, (r) => r.ip),
  limit('otp-email', 10, 3600, (r) => String(r.body.email || '').toLowerCase()),
  requestOtp);
app.post('/api/auth/verify-otp', limit('verify-ip', 100, 900, (r) => r.ip), verifyOtp);
app.post('/api/auth/logout', requireAuth(), logout);

// ---------- Profile ----------
app.get('/api/me', requireAuth(), async (req, res) => {
  const u = req.user;
  const sql = u.role === 'student'
    ? 'SELECT semester, course, batch FROM student_profile WHERE user_id = $1'
    : 'SELECT courses, free_place, free_location FROM teacher_profile WHERE user_id = $1';
  const { rows: [profile] } = await pg.query(sql, [u.id]);
  res.json({ user: u, profile: profile || {} });
});

app.put('/api/me/profile', requireAuth(), async (req, res) => {
  const u = req.user;
  const text = (v, n) => String(v || '').trim().slice(0, n);
  if (u.role === 'student') {
    const semester = Number(req.body.semester), course = text(req.body.course, 60), batch = text(req.body.batch, 20);
    if (!(semester >= 1 && semester <= 8) || !course || !batch) return res.status(400).json({ error: 'Choose semester, course and batch.' });
    await pg.query(
      `INSERT INTO student_profile (user_id, semester, course, batch) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET semester=$2, course=$3, batch=$4`, [u.id, semester, course, batch]);
  } else {
    const name = text(req.body.name, 80), place = req.body.free_place || null;
    if (!name) return res.status(400).json({ error: 'Add your name.' });
    if (place && !['classroom', 'office_desk'].includes(place)) return res.status(400).json({ error: 'Pick classroom or office desk.' });
    await pg.query('UPDATE users SET name = $1 WHERE id = $2', [name, u.id]);
    await pg.query(
      `INSERT INTO teacher_profile (user_id, courses, free_place, free_location) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id) DO UPDATE SET courses=$2, free_place=$3, free_location=$4`,
      [u.id, text(req.body.courses, 300), place, text(req.body.free_location, 100)]);
  }
  res.json({ ok: true });
});

// ---------- Live room status ----------
app.get('/api/status', requireAuth(), async (req, res) => {
  const { rows } = await pg.query(
    `SELECT r.floor, r.room_no, l.faculty,
            to_char(l.from_time,'HH24:MI') AS from_time, to_char(l.to_time,'HH24:MI') AS to_time
     FROM live_status l JOIN rooms r ON r.id = l.room_id`);
  res.json(rows);
});

// Conflict rule from the proposal. A class is the vector (room, hour, floor).
// Two classes clash when A x B = 0 (parallel) and |A|^2 = |B|^2 (equal length).
const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
const len2 = (a) => a[0]**2 + a[1]**2 + a[2]**2;
const hours = (from, to) => {
  const a = Number(from.slice(0, 2)), b = Math.ceil(Number(to.slice(0, 2)) + Number(to.slice(3)) / 60);
  return Array.from({ length: Math.max(b - a, 0) }, (_, i) => a + i);
};
const vectors = (room, floor, from, to) => hours(from, to).map((h) => [room, h, floor]);
const clashes = (A, B) => A.some((a) => B.some((b) => cross(a, b).every((c) => c === 0) && len2(a) === len2(b)));

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
app.put('/api/rooms/:floor/:room', requireAuth('teacher', 'admin', 'superadmin'), async (req, res) => {
  const floor = Number(req.params.floor), no = Number(req.params.room);
  const { status, faculty, from, to } = req.body;
  if (!Number.isInteger(floor) || floor < 0 || floor > 8 || !Number.isInteger(no) || no < 1 || no > 20) {
    return res.status(400).json({ error: 'That room does not exist.' });
  }
  const { rows: [room] } = await pg.query('SELECT id FROM rooms WHERE floor=$1 AND room_no=$2', [floor, no]);
  if (!room) return res.status(404).json({ error: 'That room does not exist.' });

  if (status === 'free') {
    await pg.query('DELETE FROM live_status WHERE room_id = $1', [room.id]);
    return res.json({ ok: true });
  }
  if (status !== 'occupied') return res.status(400).json({ error: 'Status must be free or occupied.' });
  if (!String(faculty || '').trim() || !TIME.test(from) || !TIME.test(to) || from < '08:00' || to > '17:00' || to <= from) {
    return res.status(400).json({ error: 'Add the faculty name and a from-to time between 08:00 and 17:00.' });
  }

  const db = await pg.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1)', [room.id]); // two requests for one room run one after the other
    const { rows: [cur] } = await db.query(
      `SELECT to_char(from_time,'HH24:MI') f, to_char(to_time,'HH24:MI') t, updated_by FROM live_status WHERE room_id = $1`, [room.id]);
    if (cur && cur.updated_by !== req.user.id && clashes(vectors(no, floor, from, to), vectors(no, floor, cur.f, cur.t))) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Room already occupied at this time.' });
    }
    await db.query(
      `INSERT INTO live_status (room_id, faculty, from_time, to_time, updated_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (room_id) DO UPDATE SET faculty=$2, from_time=$3, to_time=$4, updated_by=$5, updated_at=now()`,
      [room.id, String(faculty).trim().slice(0, 80), from, to, req.user.id]);
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
});

// ---------- Admin ----------
const ADMINS = ['admin', 'superadmin'];
const managedBy = (role) => (role === 'superadmin' ? ['teacher', 'timetable_manager', 'admin'] : ['teacher', 'timetable_manager']);

app.get('/api/admin/users', requireAuth(...ADMINS), async (req, res) => {
  const { rows } = await pg.query(`SELECT id, name, email, role FROM users WHERE role <> 'student' ORDER BY role, name`);
  res.json(rows);
});

app.post('/api/admin/users', requireAuth(...ADMINS), async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const { role } = req.body;
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Add a name and a valid email.' });
  if (!managedBy(req.user.role).includes(role)) return res.status(403).json({ error: 'You cannot create that role.' });
  // A student who already logged in is promoted; an existing staff account is left alone.
  const { rows } = await pg.query(
    `INSERT INTO users (name, email, role, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, created_by = EXCLUDED.created_by
     WHERE users.role = 'student' RETURNING id, name, email, role`, [name, email, role, req.user.id]);
  if (!rows.length) return res.status(409).json({ error: 'That email already has a staff account.' });
  res.status(201).json(rows[0]);
});

app.delete('/api/admin/users/:id', requireAuth(...ADMINS), async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [target] } = await pg.query('SELECT id, role FROM users WHERE id = $1', [id]);
  if (!target) return res.status(404).json({ error: 'Account not found.' });
  if (target.id === req.user.id || !managedBy(req.user.role).includes(target.role)) {
    return res.status(403).json({ error: 'You cannot remove this account.' });
  }
  await pg.query('DELETE FROM users WHERE id = $1', [id]); // their next request fails: access ends at once
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const port = Number(process.env.PORT) || 3000;
redis.connect().then(() => app.listen(port, () => console.log(`ClassSync running on http://localhost:${port}`)));
