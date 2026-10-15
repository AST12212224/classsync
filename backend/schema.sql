-- ClassSync schema (PostgreSQL). Safe to run again: the server runs it on every start,
-- and it upgrades a database made by the first version (fixed floors 0-8, rooms 1-20).
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('student','teacher','timetable_manager','admin','superadmin')),
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Floors and rooms are added and named by an admin.
CREATE TABLE IF NOT EXISTS floors (
  id    SERIAL PRIMARY KEY,
  level INT UNIQUE NOT NULL CHECK (level BETWEEN -5 AND 200),  -- 0 = ground, used for ordering
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id        SERIAL PRIMARY KEY,
  floor_id  INT NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  room_type TEXT NOT NULL DEFAULT 'classroom' CHECK (room_type IN ('classroom','lab')),
  UNIQUE (floor_id, name)
);

-- Upgrade: the first version stored rooms as (floor, room_no) numbers.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'rooms' AND column_name = 'room_no') THEN
    INSERT INTO floors (level, name)
      SELECT DISTINCT floor, CASE WHEN floor = 0 THEN 'Ground floor' ELSE 'Floor ' || floor END FROM rooms
      ON CONFLICT (level) DO NOTHING;
    ALTER TABLE rooms ADD COLUMN floor_id INT REFERENCES floors(id) ON DELETE CASCADE, ADD COLUMN name TEXT;
    UPDATE rooms r SET floor_id = f.id, name = 'Room ' || r.room_no FROM floors f WHERE f.level = r.floor;
    ALTER TABLE rooms
      DROP COLUMN floor, DROP COLUMN room_no,
      ALTER COLUMN floor_id SET NOT NULL, ALTER COLUMN name SET NOT NULL,
      ADD CONSTRAINT rooms_floor_id_name_key UNIQUE (floor_id, name),
      ADD CONSTRAINT rooms_room_type_check CHECK (room_type IN ('classroom','lab'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS student_profile (
  user_id  INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  semester INT CHECK (semester BETWEEN 1 AND 8),
  course   TEXT,
  batch    TEXT
);

CREATE TABLE IF NOT EXISTS teacher_profile (
  user_id       INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  courses       TEXT,
  free_place    TEXT CHECK (free_place IN ('classroom','office_desk')),
  free_location TEXT
);

-- Live bookings made by teachers for one day. A room is occupied while a booking
-- or a timetabled class covers the current time.
CREATE TABLE IF NOT EXISTS bookings (
  id         SERIAL PRIMARY KEY,
  room_id    INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  faculty    TEXT NOT NULL,
  subject    TEXT,
  from_time  TIME NOT NULL,
  to_time    TIME NOT NULL,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_time > from_time)
);
CREATE INDEX IF NOT EXISTS bookings_room_day ON bookings (room_id, day);

-- Upgrade: the first version kept one live_status row per room. Carry it over as a booking.
DO $$ BEGIN
  IF to_regclass('public.live_status') IS NOT NULL THEN
    INSERT INTO bookings (room_id, day, faculty, from_time, to_time, created_by)
      SELECT room_id, (updated_at AT TIME ZONE 'Asia/Kolkata')::date, faculty, from_time, to_time, updated_by FROM live_status;
    DROP TABLE live_status;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, semester INT NOT NULL, course TEXT NOT NULL,
  UNIQUE (name, semester, course)
);
CREATE TABLE IF NOT EXISTS timetable (
  id        SERIAL PRIMARY KEY,
  batch_id  INT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  room_id   INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  day       INT NOT NULL CHECK (day BETWEEN 1 AND 7),          -- 1 = Monday
  time_slot INT NOT NULL CHECK (time_slot BETWEEN 8 AND 17),   -- start hour of a one-hour slot (08:00-18:00)
  subject   TEXT NOT NULL,
  faculty   TEXT,
  UNIQUE (room_id, day, time_slot)   -- final safeguard against double booking a room
);
-- A timetabled class a teacher freed for one day (class cancelled or moved): the room shows free.
CREATE TABLE IF NOT EXISTS cancellations (
  timetable_id INT NOT NULL REFERENCES timetable(id) ON DELETE CASCADE,
  day          DATE NOT NULL,
  cancelled_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (timetable_id, day)
);
-- One class per batch per slot
CREATE UNIQUE INDEX IF NOT EXISTS timetable_batch_slot ON timetable (batch_id, day, time_slot);
-- Upgrade: the day now runs to 18:00, so allow the 17:00 slot
ALTER TABLE timetable DROP CONSTRAINT IF EXISTS timetable_time_slot_check;
ALTER TABLE timetable ADD CONSTRAINT timetable_time_slot_check CHECK (time_slot BETWEEN 8 AND 17);
-- Upgrade: removing a room now removes its timetable entries too
ALTER TABLE timetable DROP CONSTRAINT IF EXISTS timetable_room_id_fkey;
ALTER TABLE timetable ADD CONSTRAINT timetable_room_id_fkey FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;
