// Planned weekly timetable, entered batch by batch by a timetable manager.
const express = require('express');
const { pg } = require('./db');
const { requireAuth } = require('./auth');
const { now, FIRST_SLOT, LAST_SLOT, slotBlocks, vectors, clashes } = require('./schedule');

const router = express.Router();
const MANAGERS = ['timetable_manager', 'admin', 'superadmin'];
const text = (v, n) => String(v ?? '').trim().slice(0, n);
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

const batchInput = (src) => {
  const course = text(src.course, 60), semester = Number(src.semester), batch = text(src.batch, 20);
  return course && batch && semester >= 1 && semester <= 8 && Number.isInteger(semester) ? { course, semester, batch } : null;
};

// Anyone logged in can read a batch's week (students use it for "my classes").
router.get('/timetable', requireAuth(), async (req, res) => {
  const b = batchInput(req.query);
  if (!b) return res.status(400).json({ error: 'Choose course, semester and batch.' });
  const { rows } = await pg.query(
    `SELECT t.id, t.day, t.time_slot AS slot, t.subject, t.faculty, r.id AS room_id, r.name AS room, f.name AS floor,
            (c.timetable_id IS NOT NULL) AS freed_today
       FROM timetable t JOIN batches b ON b.id = t.batch_id
       JOIN rooms r ON r.id = t.room_id JOIN floors f ON f.id = r.floor_id
       LEFT JOIN cancellations c ON c.timetable_id = t.id AND c.day = $4
      WHERE b.course = $1 AND b.semester = $2 AND b.name = $3
      ORDER BY t.day, t.time_slot`, [b.course, b.semester, b.batch, now().date]);
  res.json(rows);
});

// Sets (or replaces) the class a batch has in one slot.
router.put('/timetable', requireAuth(...MANAGERS), async (req, res) => {
  const b = batchInput(req.body);
  const day = Number(req.body.day), slot = Number(req.body.slot), roomId = toId(req.body.room_id);
  const subject = text(req.body.subject, 80), faculty = text(req.body.faculty, 80);
  if (!b || !(day >= 1 && day <= 7) || !(Number.isInteger(slot) && slot >= FIRST_SLOT && slot <= LAST_SLOT) || !roomId || !subject) {
    return res.status(400).json({ error: 'Choose the batch, day, time, room and subject.' });
  }
  const db = await pg.connect();
  try {
    await db.query('BEGIN');
    const { rows: [room] } = await db.query(
      'SELECT r.id, f.level FROM rooms r JOIN floors f ON f.id = r.floor_id WHERE r.id = $1', [roomId]);
    if (!room) { await db.query('ROLLBACK'); return res.status(404).json({ error: 'That room does not exist.' }); }
    await db.query('SELECT pg_advisory_xact_lock($1)', [room.id]);
    const { rows: [batch] } = await db.query(
      `INSERT INTO batches (name, semester, course) VALUES ($1,$2,$3)
       ON CONFLICT (name, semester, course) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [b.batch, b.semester, b.course]);

    // Same clash rule as live bookings, against other batches using this room that day.
    const { rows: others } = await db.query(
      `SELECT t.time_slot, b.course, b.semester, b.name FROM timetable t JOIN batches b ON b.id = t.batch_id
        WHERE t.room_id = $1 AND t.day = $2 AND t.batch_id <> $3`, [room.id, day, batch.id]);
    const hit = others.find((o) => clashes(vectors(room.id, room.level, slotBlocks(slot)), vectors(room.id, room.level, slotBlocks(o.time_slot))));
    if (hit) {
      await db.query('ROLLBACK');
      return res.status(409).json({ error: `Room already used by ${hit.course} Sem ${hit.semester} ${hit.name} at this time.` });
    }
    const { rows: [row] } = await db.query(
      `INSERT INTO timetable (batch_id, room_id, day, time_slot, subject, faculty) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (batch_id, day, time_slot) DO UPDATE SET room_id = $2, subject = $5, faculty = $6 RETURNING id`,
      [batch.id, room.id, day, slot, subject, faculty || null]);
    await db.query('COMMIT');
    res.json(row);
  } catch (e) {
    await db.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Room already occupied at this time.' });
    throw e;
  } finally {
    db.release();
  }
});

router.delete('/timetable/:id', requireAuth(...MANAGERS), async (req, res) => {
  const { rowCount } = await pg.query('DELETE FROM timetable WHERE id = $1', [toId(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: 'Entry not found.' });
  res.json({ ok: true });
});

module.exports = router;
