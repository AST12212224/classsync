// Creates the first super admin. Run once after db:init: npm run seed
require('dotenv').config();
const { pg } = require('./db');

(async () => {
  const email = (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  if (!email) throw new Error('Set SUPERADMIN_EMAIL in .env');
  await pg.query(
    `INSERT INTO users (name, email, role) VALUES ('Super admin', $1, 'superadmin')
     ON CONFLICT (email) DO UPDATE SET role = 'superadmin'`, [email]);
  console.log('Super admin ready:', email);
  await pg.end();
})();
