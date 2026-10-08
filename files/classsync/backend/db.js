require('dotenv').config();
const { Pool } = require('pg');
const { createClient } = require('redis');

const pg = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
redis.on('error', (e) => console.error('Redis error:', e.message));

module.exports = { pg, redis };
