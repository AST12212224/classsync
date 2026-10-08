-- ClassSync schema (PostgreSQL). Run: npm run db:init
CREATE TABLE users (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('student','teacher','timetable_manager','admin','superadmin')),
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id        SERIAL PRIMARY KEY,
  floor     INT NOT NULL CHECK (floor BETWEEN 0 AND 8),
  room_no   INT NOT NULL CHECK (room_no BETWEEN 1 AND 20),
  room_type TEXT NOT NULL DEFAULT 'classroom',  -- update once the real room list arrives
  UNIQUE (floor, room_no)
);
INSERT INTO rooms (floor, room_no)
SELECT f, r FROM generate_series(0,8) f, generate_series(1,20) r;

CREATE TABLE student_profile (
  user_id  INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  semester INT CHECK (semester BETWEEN 1 AND 8),
  course   TEXT,
  batch    TEXT
);

CREATE TABLE teacher_profile (
  user_id       INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  courses       TEXT,
  free_place    TEXT CHECK (free_place IN ('classroom','office_desk')),
  free_location TEXT
);

-- One row per room that is occupied right now. A free room has no row.
CREATE TABLE live_status (
  room_id    INT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  faculty    TEXT NOT NULL,
  from_time  TIME NOT NULL,
  to_time    TIME NOT NULL,
  updated_by INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (to_time > from_time)
);

-- For the Timetable Manager module (next step)
CREATE TABLE batches (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, semester INT NOT NULL, course TEXT NOT NULL,
  UNIQUE (name, semester, course)
);
CREATE TABLE timetable (
  id        SERIAL PRIMARY KEY,
  batch_id  INT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  room_id   INT NOT NULL REFERENCES rooms(id),
  day       INT NOT NULL CHECK (day BETWEEN 1 AND 7),
  time_slot INT NOT NULL CHECK (time_slot BETWEEN 8 AND 16),
  subject   TEXT NOT NULL,
  faculty   TEXT,
  UNIQUE (room_id, day, time_slot)   -- final safeguard against double booking
);
