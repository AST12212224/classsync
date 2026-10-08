// Floors, rooms, live status and bookings.
const express = require('express');
const { pg } = require('./db');
const { requireAuth } = require('./auth');
const { now, OPEN, CLOSE, TIME, blocks, slotBlocks, vectors, clashes } = require('./schedule');

const router = express.Router();
const STAFF = ['teacher', 'admin', 'superadmin'];
const ADMINS = ['admin', 'superadmin'];
const TYPES = ['classroom', 'lab'];
const text = (v, n) => String(v ?? '').trim().slice(0, n);
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };
const byName = (a, b) => a.name.localeCompare(b.name, 'en', { numeric: true });

// Today's holds and timetabled classes for one room (or all rooms when roomId is null).
// A class a teacher freed for today comes back with freed_by set and does not occupy the room.
const TODAY_SQL = `
  SELECT 'booking' AS kind, bk.id, bk.room_id, bk.faculty, bk.subject, NULL AS batch,
         to_char(bk.from_time,'HH24:MI') AS "from", to_char(bk.to_time,'HH24:MI') AS "to", bk.created_by, NULL AS freed_by
    FROM bookings bk WHERE bk.day = $1 AND ($3::int IS NULL OR bk.room_id = $3)
  UNION ALL
  SELECT 'class', t.id, t.room_id, t.faculty, t.subject, b.course || ' · Sem ' || b.semester || ' · ' || b.name,
         lpad(t.time_slot::text, 2, '0') || ':00', lpad((t.time_slot + 1)::text, 2, '0') || ':00', NULL,
         CASE WHEN c.timetable_id IS NOT NULL THEN COALESCE(u.name, 'a teacher') END
    FROM timetable t JOIN batches b ON b.id = t.batch_id
    LEFT JOIN cancellations c ON c.timetable_id = t.id AND c.day = $1
    LEFT JOIN users u ON u.id = c.cancelled_by
   WHERE t.day = $2 AND ($3::int IS NULL OR t.room_id = $3)
  ORDER BY 7`;
const today = (db, t, roomId) => db.query(TODAY_SQL, [t.date, t.day, roomId]).then((r) => r.rows);
// Only entries that actually occupy the room (freed classes do not).
const holding = (rows) => rows.filter((x) => !x.freed_by);

// ---------- Building view ----------
router.get('/building', requireAuth(), async (req, res) => {
  const t = now();
  const { rows: floors } = await pg.query('SELECT id, level, name FROM floors ORDER BY level DESC');
  const { rows: rooms } = await pg.query('SELECT id, floor_id, name, room_type AS type FROM rooms');
  const busy = {};
  for (const x of holding(await today(pg, t, null))) {
    if (x.from <= t.time && t.time < x.to && !busy[x.room_id]) busy[x.room_id] = x;
  }
  res.json({
    now: t,
    floors: floors.map((f) => ({
      ...f,
      rooms: rooms.filter((r) => r.floor_id === f.id).sort(byName).map((r) => {
        const b = busy[r.id];
        return { id: r.id, name: r.name, type: r.type, busy: b ? { faculty: b.faculty, subject: b.subject, batch: b.batch, from: b.from, to: b.to } : null };
      }),
    })),
  });
});

router.get('/rooms/:id/schedule', requireAuth(), async (req, res) => {
  const t = now();
  const { rows: [room] } = await pg.query(
    `SELECT r.id, r.name, r.room_type AS type, f.name AS floor FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = $1`,
    [toId(req.params.id)]);
  if (!room) return res.status(404).json({ error: 'That room does not exist.' });
  res.json({ room, now: t, items: await today(pg, t, room.id) });
});

// ---------- Holds (a teacher takes a room for part of today: red until freed) ----------
router.post('/rooms/:id/bookings', requireAuth(...STAFF), async (req, res) => {
  const faculty = text(req.body.faculty, 80), subject = text(req.body.subject, 80);
  const { from, to } = req.body;
  if (!faculty || !TIME.test(from) || !TIME.test(to) || from < OPEN || to > CLOSE || to <= from) {
    return res.status(400).json({ error: 'Add the faculty name and a from-to time between 8:00 AM and 6:00 PM, in 15-minute steps.' });
  }
  const t = now();
  const db = await pg.connect();
  try {
    await db.query('BEGIN');
    const { rows: [room] } = await db.query(
      'SELECT r.id, f.level FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = $1', [toId(req.params.id)]);
    if (!room) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'That room does not exist.' }); }
    await db.query('SELECT pg_advisory_xact_lock($1)', [room.id]); // two requests for one room run one after the other
    const mine = vectors(room.id, room.level, blocks(from, to));
    const taken = holding(await today(db, t, room.id));
    if (taken.some((x) => clashes(mine, vectors(room.id, room.level, blocks(x.from, x.to))))) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Room already occupied at this time.' });
    }
    const { rows: [b] } = await db.query(
      `INSERT INTO bookings (room_id, day, faculty, subject, from_time, to_time, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [room.id, t.date, faculty, subject || null, from, to, req.user.id]);
    await db.query('COMMIT');
    res.status(201).json(b);
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
});

// Frees the room: teachers remove their own bookings, admins any booking.
router.delete('/bookings/:id', requireAuth(...STAFF), async (req, res) => {
  const { rows: [b] } = await pg.query('SELECT id, created_by FROM bookings WHERE id = $1', [toId(req.params.id)]);
  if (!b) return res.status(404).json({ error: 'Booking not found.' });
  if (b.created_by !== req.user.id && !ADMINS.includes(req.user.role)) {
    return res.status(403).json({ error: 'You can only free rooms you booked.' });
  }
  await pg.query('DELETE FROM bookings WHERE id = $1', [b.id]);
  res.json({ ok: true });
});

// Frees a room held by today's timetabled class (class cancelled or moved). Any teacher can do
// this; who did it is recorded and shown. It applies to today only.
router.post('/classes/:id/free', requireAuth(...STAFF), async (req, res) => {
  const t = now();
  const { rows: [c] } = await pg.query('SELECT id, day FROM timetable WHERE id = $1', [toId(req.params.id)]);
  if (!c) return res.status(404).json({ error: 'Class not found.' });
  if (c.day !== t.day) return res.status(400).json({ error: 'You can only free a class that is on today.' });
  await pg.query(
    `INSERT INTO cancellations (timetable_id, day, cancelled_by) VALUES ($1,$2,$3)
     ON CONFLICT (timetable_id, day) DO NOTHING`, [c.id, t.date, req.user.id]);
  res.json({ ok: true });
});

// Undo: the class holds the room again, unless someone has taken the room in the meantime.
router.delete('/classes/:id/free', requireAuth(...STAFF), async (req, res) => {
  const t = now();
  const db = await pg.connect();
  try {
    await db.query('BEGIN');
    const { rows: [c] } = await db.query(
      `SELECT t.id, t.room_id, t.time_slot, f.level, cn.cancelled_by FROM timetable t
         JOIN rooms r ON r.id = t.room_id JOIN floors f ON f.id = r.floor_id
         JOIN cancellations cn ON cn.timetable_id = t.id AND cn.day = $2
        WHERE t.id = $1`, [toId(req.params.id), t.date]);
    if (!c) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'That class is not freed today.' }); }
    if (c.cancelled_by !== req.user.id && !ADMINS.includes(req.user.role)) {
      await db.query('ROLLBACK');
      return res.status(403).json({ error: 'Only the teacher who freed this class can undo it.' });
    }
    await db.query('SELECT pg_advisory_xact_lock($1)', [c.room_id]);
    const mine = vectors(c.room_id, c.level, slotBlocks(c.time_slot));
    const taken = holding(await today(db, t, c.room_id)).filter((x) => x.kind === 'booking');
    if (taken.some((x) => clashes(mine, vectors(c.room_id, c.level, blocks(x.from, x.to))))) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: 'Someone has taken the room since. They need to free it first.' });
    }
    await db.query('DELETE FROM cancellations WHERE timetable_id = $1 AND day = $2', [c.id, t.date]);
    await db.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
});

// ---------- Admin: floors and rooms ----------
const pgError = (res, e, dup) => {
  if (e.code === '23505') return res.status(409).json({ error: dup });
  if (e.code === '23503') return res.status(404).json({ error: 'That floor does not exist.' });
  throw e;
};
const floorInput = (body) => {
  const level = body.level == null || body.level === '' ? NaN : Number(body.level), name = text(body.name, 60);
  return Number.isInteger(level) && level >= -5 && level <= 200 && name ? { level, name } : null;
};
const FLOOR_BAD = 'Give the floor a number (-5 to 200, 0 = ground) and a name.';
const FLOOR_DUP = 'There is already a floor with that number.';
const ROOM_DUP = 'A room with that name already exists on this floor.';

router.post('/admin/floors', requireAuth(...ADMINS), async (req, res) => {
  const f = floorInput(req.body);
  if (!f) return res.status(400).json({ error: FLOOR_BAD });
  try {
    const { rows: [row] } = await pg.query('INSERT INTO floors (level, name) VALUES ($1,$2) RETURNING *', [f.level, f.name]);
    res.status(201).json(row);
  } catch (e) { pgError(res, e, FLOOR_DUP); }
});

router.put('/admin/floors/:id', requireAuth(...ADMINS), async (req, res) => {
  const f = floorInput(req.body);
  if (!f) return res.status(400).json({ error: FLOOR_BAD });
  try {
    const { rows: [row] } = await pg.query(
      'UPDATE floors SET level = $1, name = $2 WHERE id = $3 RETURNING *', [f.level, f.name, toId(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'That floor does not exist.' });
    res.json(row);
  } catch (e) { pgError(res, e, FLOOR_DUP); }
});

router.delete('/admin/floors/:id', requireAuth(...ADMINS), async (req, res) => {
  const { rowCount } = await pg.query('DELETE FROM floors WHERE id = $1', [toId(req.params.id)]); // its rooms go too
  if (!rowCount) return res.status(404).json({ error: 'That floor does not exist.' });
  res.json({ ok: true });
});

// Accepts one `name` or a list of `names` (up to 50) so a whole corridor can be added at once.
router.post('/admin/rooms', requireAuth(...ADMINS), async (req, res) => {
  const list = Array.isArray(req.body.names) ? req.body.names : [req.body.name];
  const names = [...new Set(list.map((n) => text(n, 40)))];
  const floorId = toId(req.body.floor_id), type = req.body.type;
  if (!floorId || !TYPES.includes(type) || !names.length || names.length > 50 || names.some((n) => !n)) {
    return res.status(400).json({ error: 'Pick a floor and a type, and name each room (up to 50 at a time).' });
  }
  try {
    const { rows } = await pg.query(
      `INSERT INTO rooms (floor_id, name, room_type) SELECT $1, unnest($2::text[]), $3
       RETURNING id, floor_id, name, room_type AS type`, [floorId, names, type]);
    res.status(201).json(rows);
  } catch (e) { pgError(res, e, ROOM_DUP); }
});

router.put('/admin/rooms/:id', requireAuth(...ADMINS), async (req, res) => {
  const name = text(req.body.name, 40), type = req.body.type, floorId = toId(req.body.floor_id);
  if (!name || !TYPES.includes(type) || !floorId) return res.status(400).json({ error: 'Give the room a name, a type and a floor.' });
  try {
    const { rows: [row] } = await pg.query(
      `UPDATE rooms SET name = $1, room_type = $2, floor_id = $3 WHERE id = $4
       RETURNING id, floor_id, name, room_type AS type`, [name, type, floorId, toId(req.params.id)]);
    if (!row) return res.status(404).json({ error: 'That room does not exist.' });
    res.json(row);
  } catch (e) { pgError(res, e, ROOM_DUP); }
});

router.delete('/admin/rooms/:id', requireAuth(...ADMINS), async (req, res) => {
  const { rowCount } = await pg.query('DELETE FROM rooms WHERE id = $1', [toId(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'That room does not exist.' });
  res.json({ ok: true });
});

module.exports = router;
