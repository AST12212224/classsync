require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { pg, redis } = require('./db');
const { limit, requestOtp, verifyOtp, requireAuth, logout } = require('./auth');
const { now } = require('./schedule');

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

// ---------- Building, bookings, timetable ----------
app.use('/api', require('./building'), require('./timetable'));

// Teacher directory: where to find each teacher when they have no class.
app.get('/api/teachers', requireAuth(), async (req, res) => {
  const t = now();
  const { rows } = await pg.query(
    `SELECT u.id, u.name, u.email, p.courses, p.free_place, p.free_location, n.room AS teaching_room, n.floor AS teaching_floor
       FROM users u LEFT JOIN teacher_profile p ON p.user_id = u.id
       LEFT JOIN LATERAL (
         SELECT r.name AS room, f.name AS floor FROM bookings b
           JOIN rooms r ON r.id = b.room_id JOIN floors f ON f.id = r.floor_id
          WHERE b.created_by = u.id AND b.day = $1 AND b.from_time <= $2 AND b.to_time > $2 LIMIT 1) n ON true
      WHERE u.role = 'teacher' ORDER BY u.name`, [t.date, t.time]);
  res.json(rows);
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

// On start: create or upgrade the tables (schema.sql is safe to rerun) and make sure the super admin exists.
async function prepareDatabase() {
  await pg.query(require('fs').readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const email = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  if (email) {
    await pg.query(
      `INSERT INTO users (name, email, role) VALUES ('Super admin', $1, 'superadmin')
       ON CONFLICT (email) DO UPDATE SET role = 'superadmin'`, [email]);
  }
}

const port = Number(process.env.PORT) || 3000;
redis.connect()
  .then(prepareDatabase)
  .then(() => app.listen(port, () => console.log(`ClassSync running on port ${port}`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
