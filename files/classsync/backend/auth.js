const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { pg, redis } = require('./db');

const SECRET = process.env.JWT_SECRET;
const DOMAIN = (process.env.STUDENT_DOMAIN || '@spit.ac.in').toLowerCase();
const TOKEN_SECONDS = (Number(process.env.JWT_HOURS) || 8) * 3600;
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

  const token = jwt.sign({ sub: user.id, role: user.role, jti: crypto.randomUUID() }, SECRET, {
    algorithm: 'HS256',
    expiresIn: TOKEN_SECONDS,
  });
  res.cookie('cs_token', token, {
    httpOnly: true,                 // page scripts cannot read it
    sameSite: 'strict',             // not sent on cross-site requests
    secure: process.env.NODE_ENV === 'production',
    maxAge: TOKEN_SECONDS * 1000,
  });
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

async function logout(req, res) {
  const ttl = Math.max(1, req.exp - Math.floor(Date.now() / 1000));
  await redis.set(`revoked:${req.jti}`, '1', { EX: ttl }); // token is dead even if copied
  res.clearCookie('cs_token');
  res.json({ ok: true });
}

module.exports = { limit, requestOtp, verifyOtp, requireAuth, logout };
