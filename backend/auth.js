const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { pg, redis } = require('./db');

const SECRET = process.env.JWT_SECRET;
const DOMAIN = (process.env.STUDENT_DOMAIN || '@spit.ac.in').toLowerCase();
const DAY = 86400;
// Lifetimes in days from .env; a typo or a value of 0 or less stops the server instead of being ignored.
const days = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback * DAY;
  const n = Number(raw);
  if (!(n > 0)) throw new Error(`${name} must be a number of days above 0 (got "${raw}")`);
  return Math.round(n * DAY);
};
const ACCESS_SECONDS = days('ACCESS_DAYS', 7);
const REFRESH_SECONDS = days('REFRESH_DAYS', 180);          // students, teachers, timetable managers
const ADMIN_REFRESH_SECONDS = days('ADMIN_REFRESH_DAYS', 7); // admins log in again every week
const MAX_SESSIONS = 10;      // per user; the oldest logins are ended first
const RACE_SECONDS = 30;      // another tab may still send the token that was just replaced

// When a session ends: a fixed time after login, chosen by the user's current role,
// so someone made admin is held to the weekly limit at once. Needs `s` (sessions) and `u` (users).
const SESSION_END = `s.login_at + make_interval(secs => CASE WHEN u.role IN ('admin','superadmin')
  THEN ${ADMIN_REFRESH_SECONDS} ELSE ${REFRESH_SECONDS} END)`;
const SECONDS_LEFT = `floor(extract(epoch FROM ${SESSION_END} - now()))::int`;
const OTP_SECONDS = 300;
const MAX_TRIES = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function sendOtp(email, otp) {
  if (!mailer) return console.log(`[dev] login code for ${email}: ${otp}`);
  await mailer.sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject: 'Your ClassSync login code',
    text: `Your code is ${otp}. It works once and expires in 5 minutes.`,
  });
}

// Codes are stored as an HMAC, never in plain text.
const hashOtp = (email, otp) => crypto.createHmac('sha256', SECRET).update(`${email}:${otp}`).digest('hex');
const cleanEmail = (v) => String(v || '').trim().toLowerCase();

// Fixed-window counter in Redis: at most `max` hits per `windowSec` for each key.
const limit = (name, max, windowSec, keyFn) => async (req, res, next) => {
  const key = `rl:${name}:${keyFn(req)}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSec);
  if (n > max) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  next();
};

async function requestOtp(req, res) {
  const email = cleanEmail(req.body.email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });

  // One code per minute per email, applied to every address so the reply reveals nothing.
  const fresh = await redis.set(`otp_cd:${email}`, '1', { EX: 60, NX: true });
  if (!fresh) return res.status(429).json({ error: 'Wait a minute before asking for another code.' });

  const { rows } = await pg.query('SELECT 1 FROM users WHERE email = $1', [email]);
  if (rows.length || email.endsWith(DOMAIN)) {
    const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await redis.set(`otp:${email}`, JSON.stringify({ h: hashOtp(email, otp), t: 0 }), { EX: OTP_SECONDS });
    await sendOtp(email, otp);
  }
  res.json({ ok: true }); // same reply whether or not the email can log in
}

async function verifyOtp(req, res) {
  const email = cleanEmail(req.body.email);
  const otp = String(req.body.otp || '');
  const bad = () => res.status(401).json({ error: 'The code is wrong or has expired.' });

  const raw = await redis.get(`otp:${email}`);
  if (!raw || !/^\d{6}$/.test(otp)) return bad();
  const rec = JSON.parse(raw);

  const ok = crypto.timingSafeEqual(Buffer.from(rec.h), Buffer.from(hashOtp(email, otp)));
  if (!ok) {
    rec.t += 1;
    if (rec.t >= MAX_TRIES) await redis.del(`otp:${email}`);
    else await redis.set(`otp:${email}`, JSON.stringify(rec), { KEEPTTL: true });
    return bad();
  }
  await redis.del(`otp:${email}`); // single use

  let { rows: [user] } = await pg.query('SELECT id, name, email, role FROM users WHERE email = $1', [email]);
  if (!user) {
    if (!email.endsWith(DOMAIN)) return bad();
    ({ rows: [user] } = await pg.query(
      `INSERT INTO users (name, email, role) VALUES ($1, $2, 'student')
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, name, email, role`,
      [email.split('@')[0], email]
    ));
  }

  await endSession(req); // a previous login in this browser
  await pg.query(`DELETE FROM sessions s USING users u WHERE u.id = s.user_id AND ${SESSION_END} <= now()`);
  const sid = crypto.randomUUID();
  const refreshToken = newRefreshToken();
  const { rows: [{ seconds_left: left }] } = await pg.query(
    `WITH s AS (INSERT INTO sessions (id, user_id, refresh_hash) VALUES ($1, $2, $3) RETURNING *)
     SELECT ${SECONDS_LEFT} AS seconds_left FROM s JOIN users u ON u.id = s.user_id`,
    [sid, user.id, sha256(refreshToken)]);
  await pg.query(
    `DELETE FROM sessions WHERE user_id = $1 AND id NOT IN
       (SELECT id FROM sessions WHERE user_id = $1 ORDER BY login_at DESC LIMIT ${MAX_SESSIONS})`, [user.id]);
  setSessionCookies(res, user, sid, refreshToken, left);
  res.json({ user });
}

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newRefreshToken = () => crypto.randomBytes(32).toString('hex');
const cookieOpts = (seconds, path = '/') => ({
  httpOnly: true,                 // page scripts cannot read it
  sameSite: 'strict',             // not sent on cross-site requests
  secure: process.env.NODE_ENV === 'production',
  maxAge: seconds * 1000,
  path,
});
const clearSessionCookies = (res) => {
  res.clearCookie('cs_token');
  res.clearCookie('cs_refresh', { path: '/api/auth' });
};

// Short-lived access JWT naming the session, plus the refresh token (stored only as a hash).
// Neither outlives the session.
function setSessionCookies(res, user, sid, refreshToken, left) {
  const accessSeconds = Math.min(ACCESS_SECONDS, left);
  const access = jwt.sign({ sub: user.id, sid }, SECRET, { algorithm: 'HS256', expiresIn: accessSeconds });
  res.cookie('cs_token', access, cookieOpts(accessSeconds));
  res.cookie('cs_refresh', refreshToken, cookieOpts(left, '/api/auth')); // only sent to the auth routes
}

// Visitors who were never logged in are answered before the rate limit, so they cannot use it up.
const needsRefreshCookie = (req, res, next) =>
  readCookie(req, 'cs_refresh') ? next() : res.status(401).json({ error: 'Please log in.' });

async function refresh(req, res) {
  const hash = sha256(readCookie(req, 'cs_refresh'));
  const fresh = newRefreshToken();
  // One statement swaps the token, so two requests with the same token cannot both succeed.
  const { rows: [hit] } = await pg.query(
    `UPDATE sessions s SET prev_hash = s.refresh_hash, refresh_hash = $2, rotated_at = now()
     FROM users u WHERE u.id = s.user_id AND s.refresh_hash = $1 AND ${SESSION_END} > now()
     RETURNING s.id AS sid, u.id, u.name, u.email, u.role, ${SECONDS_LEFT} AS seconds_left`,
    [hash, sha256(fresh)]);
  if (hit) {
    const { sid, seconds_left: left, ...user } = hit;
    setSessionCookies(res, user, sid, fresh, left);
    return res.json({ user });
  }
  const { rows: [old] } = await pg.query(
    `SELECT id, rotated_at > now() - make_interval(secs => ${RACE_SECONDS}) AS recent FROM sessions WHERE prev_hash = $1`,
    [hash]);
  // Another tab refreshed a moment ago and the browser already has the new cookies: just try again.
  if (old && old.recent) return res.status(409).json({ error: 'Refreshed in another tab. Try again.' });
  // An old token used again later means it was copied: end that session for everyone holding it.
  if (old) await pg.query('DELETE FROM sessions WHERE id = $1', [old.id]);
  clearSessionCookies(res);
  res.status(401).json({ error: 'Please log in.' });
}

const readCookie = (req, name) =>
  (req.headers.cookie || '').split('; ').find((c) => c.startsWith(name + '='))?.slice(name.length + 1);

// requireAuth() lets any logged-in user in; requireAuth('admin') limits it to those roles.
// The session and role are read from the database on every request, so logging out or
// removing a user cuts access at once, even with a copied token.
const requireAuth = (...roles) => async (req, res, next) => {
  try {
    const p = jwt.verify(readCookie(req, 'cs_token'), SECRET, { algorithms: ['HS256'] });
    const { rows: [user] } = await pg.query(
      `SELECT u.id, u.name, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND ${SESSION_END} > now()`, [p.sid]);
    if (!user) throw new Error('session ended');
    if (roles.length && !roles.includes(user.role)) {
      return res.status(403).json({ error: 'You do not have access to this.' });
    }
    Object.assign(req, { user, sid: p.sid });
    next();
  } catch {
    res.status(401).json({ error: 'Please log in.' });
  }
};

// Ends the session in this browser, found by the access token (even an expired one) or the refresh token.
async function endSession(req) {
  let sid = null;
  try {
    sid = jwt.verify(readCookie(req, 'cs_token'), SECRET, { algorithms: ['HS256'], ignoreExpiration: true }).sid || null;
  } catch {}
  const r = readCookie(req, 'cs_refresh');
  const hash = r ? sha256(r) : null;
  if (sid || hash) {
    await pg.query('DELETE FROM sessions WHERE id = $1 OR refresh_hash = $2 OR prev_hash = $2', [sid, hash]);
  }
}

async function logout(req, res) {
  await endSession(req);
  clearSessionCookies(res);
  res.json({ ok: true });
}

module.exports = { limit, requestOtp, verifyOtp, needsRefreshCookie, refresh, requireAuth, logout };
