const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { pg, redis } = require('./db');

const SECRET = process.env.JWT_SECRET;
const DOMAIN = (process.env.STUDENT_DOMAIN || '@spit.ac.in').toLowerCase();
const DAY = 86400;
const ACCESS_SECONDS = (Number(process.env.ACCESS_DAYS) || 7) * DAY;
const REFRESH_SECONDS = (Number(process.env.REFRESH_DAYS) || 180) * DAY;          // students and teachers
const ADMIN_REFRESH_SECONDS = (Number(process.env.ADMIN_REFRESH_DAYS) || 7) * DAY; // admins log in again every week
const ADMIN_ROLES = ['admin', 'superadmin'];
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

  await startSession(res, user, Math.floor(Date.now() / 1000));
  res.json({ user });
}

const cookieOpts = (seconds, path = '/') => ({
  httpOnly: true,                 // page scripts cannot read it
  sameSite: 'strict',             // not sent on cross-site requests
  secure: process.env.NODE_ENV === 'production',
  maxAge: seconds * 1000,
  path,
});
const hashRefresh = (t) => crypto.createHash('sha256').update(t).digest('hex');

// A session ends a fixed time after login (6 months, or 1 week for admins); refreshing never extends it.
const sessionEnd = (role, loginAt) => loginAt + (ADMIN_ROLES.includes(role) ? ADMIN_REFRESH_SECONDS : REFRESH_SECONDS);

// Sets a short-lived access JWT and a long-lived refresh token (stored hashed in Redis, rotated on every use).
async function startSession(res, user, loginAt) {
  const left = sessionEnd(user.role, loginAt) - Math.floor(Date.now() / 1000);
  const accessSeconds = Math.min(ACCESS_SECONDS, left);
  const access = jwt.sign({ sub: user.id, role: user.role, jti: crypto.randomUUID() }, SECRET, {
    algorithm: 'HS256',
    expiresIn: accessSeconds,
  });
  const refresh = crypto.randomBytes(32).toString('hex');
  await redis.set(`refresh:${hashRefresh(refresh)}`, JSON.stringify({ uid: user.id, loginAt }), { EX: left });
  res.cookie('cs_token', access, cookieOpts(accessSeconds));
  res.cookie('cs_refresh', refresh, cookieOpts(left, '/api/auth')); // only sent to the auth routes
}

async function refresh(req, res) {
  const fail = () => {
    res.clearCookie('cs_refresh', { path: '/api/auth' });
    res.status(401).json({ error: 'Please log in.' });
  };
  const token = readCookie(req, 'cs_refresh');
  if (!token) return fail();
  const key = `refresh:${hashRefresh(token)}`;
  const raw = await redis.getDel(key); // single use: a copied old token stops working
  if (!raw) return fail();
  const { uid, loginAt } = JSON.parse(raw);
  const { rows: [user] } = await pg.query('SELECT id, name, email, role FROM users WHERE id = $1', [uid]);
  // The role is checked again, so someone made admin is held to the weekly limit from their login time.
  if (!user || sessionEnd(user.role, loginAt) <= Math.floor(Date.now() / 1000)) return fail();
  await startSession(res, user, loginAt);
  res.json({ user });
}

const readCookie = (req, name) =>
  (req.headers.cookie || '').split('; ').find((c) => c.startsWith(name + '='))?.slice(name.length + 1);

// requireAuth() lets any logged-in user in; requireAuth('admin') limits it to those roles.
// The role is read from the database on every request, so removing a user cuts access at once.
const requireAuth = (...roles) => async (req, res, next) => {
  try {
    const p = jwt.verify(readCookie(req, 'cs_token'), SECRET, { algorithms: ['HS256'] });
    if (await redis.exists(`revoked:${p.jti}`)) throw new Error('revoked');
    const { rows: [user] } = await pg.query('SELECT id, name, email, role FROM users WHERE id = $1', [p.sub]);
    if (!user) throw new Error('gone');
    if (roles.length && !roles.includes(user.role)) {
      return res.status(403).json({ error: 'You do not have access to this.' });
    }
    Object.assign(req, { user, jti: p.jti, exp: p.exp });
    next();
  } catch {
    res.status(401).json({ error: 'Please log in.' });
  }
};

// Works even when the access token has expired, so the refresh token is always cleared.
async function logout(req, res) {
  try {
    const p = jwt.verify(readCookie(req, 'cs_token'), SECRET, { algorithms: ['HS256'] });
    const ttl = Math.max(1, p.exp - Math.floor(Date.now() / 1000));
    await redis.set(`revoked:${p.jti}`, '1', { EX: ttl }); // token is dead even if copied
  } catch {}
  const r = readCookie(req, 'cs_refresh');
  if (r) await redis.del(`refresh:${hashRefresh(r)}`);
  res.clearCookie('cs_token');
  res.clearCookie('cs_refresh', { path: '/api/auth' });
  res.json({ ok: true });
}

module.exports = { limit, requestOtp, verifyOtp, refresh, requireAuth, logout };
