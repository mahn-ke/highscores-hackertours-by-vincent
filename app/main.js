import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { openapi } from './openapi.js';

const coursePattern = /^[a-z0-9_-]{1,31}$/;
const idPattern = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const earliestAchievement = 1577836800; // 2020-01-01, well before either console port.

export function createApp({
    databasePath = process.env.DATABASE_PATH || '/data/scores.sqlite',
    issuer = process.env.OAUTH_URL || 'https://sso.by.vincent.mahn.ke/realms/sso.by.vincent.mahn.ke',
    console3ds = process.env.OAUTH_CONSOLE_3DS_CLIENT_ID,
    consoleXbox = process.env.OAUTH_CONSOLE_XBOX_CLIENT_ID,
    jwks,
    now = () => Date.now(),
    rateLimit = 60,
} = {}) {
    if (!console3ds || !consoleXbox || console3ds === consoleXbox) {
        throw new Error('Two distinct OAUTH_CONSOLE_3DS_CLIENT_ID and OAUTH_CONSOLE_XBOX_CLIENT_ID values are required');
    }
    const keys = jwks || createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`));
    const clients = new Map([[console3ds, '3ds'], [consoleXbox, 'xbox']]);
    const db = new DatabaseSync(databasePath);
    db.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS scores (
            id TEXT PRIMARY KEY, course TEXT NOT NULL, name TEXT NOT NULL,
            ms INTEGER NOT NULL, platform TEXT NOT NULL, achievedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS scores_ranking ON scores(course, ms, achievedAt, id);`);
    const insert = db.prepare('INSERT INTO scores (id, course, name, ms, platform, achievedAt) VALUES (?, ?, ?, ?, ?, ?)');
    const byId = db.prepare('SELECT * FROM scores WHERE id = ?');
    const ranking = db.prepare('SELECT name, ms, platform, achievedAt FROM scores WHERE course = ? ORDER BY ms, achievedAt, id LIMIT ?');
    const buckets = new Map();
    const send = (res, status, value, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify(value));
    };
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method === 'GET' && url.pathname === '/healthz') {
                db.prepare('SELECT 1').get();
                return send(res, 200, { status: 'ok' });
            }
            if (req.method === 'GET' && url.pathname === '/openapi.json') return send(res, 200, openapi);
            if (req.method === 'GET' && url.pathname === '/api/courses') {
                return send(res, 200, db.prepare('SELECT course, COUNT(*) AS count, MIN(ms) AS bestMs FROM scores GROUP BY course ORDER BY course').all());
            }
            if (req.method === 'GET' && url.pathname.startsWith('/api/scores/')) {
                let course;
                try { course = decodeURIComponent(url.pathname.slice('/api/scores/'.length)); }
                catch { return send(res, 400, { error: 'Invalid course' }); }
                const limits = url.searchParams.getAll('limit');
                if (!coursePattern.test(course) || limits.length > 1 ||
                    (limits.length && (!/^[1-9][0-9]*$/.test(limits[0]) || !Number.isSafeInteger(Number(limits[0]))))) {
                    return send(res, 400, { error: 'Invalid course or limit' });
                }
                return send(res, 200, ranking.all(course, limits.length ? Number(limits[0]) : -1));
            }
            if (req.method !== 'POST' || url.pathname !== '/api/scores') return send(res, 404, { error: 'Not found' });
            const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
            if (!bearer) return send(res, 401, { error: 'Bearer token required' }, { 'WWW-Authenticate': 'Bearer' });
            let payload;
            try {
                ({ payload } = await jwtVerify(bearer[1], keys, {
                    issuer, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'azp'], currentDate: new Date(now()),
                }));
            } catch {
                return send(res, 401, { error: 'Invalid or expired token' }, { 'WWW-Authenticate': 'Bearer' });
            }
            const platform = clients.get(payload.azp);
            if (!platform) return send(res, 403, { error: 'Client is not allowed' });
            const minute = Math.floor(now() / 60000);
            const bucket = buckets.get(payload.azp);
            const count = bucket?.minute === minute ? bucket.count + 1 : 1;
            buckets.set(payload.azp, { minute, count });
            if (count > rateLimit) return send(res, 429, { error: 'Rate limit exceeded' }, { 'Retry-After': String(60 - Math.floor(now() / 1000) % 60) });
            if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) return send(res, 400, { error: 'Content-Type must be application/json' });
            let body;
            try {
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 4096) {
                        send(res, 400, { error: 'Body exceeds 4096 bytes' });
                        return;
                    }
                    chunks.push(chunk);
                }
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch { return send(res, 400, { error: 'Invalid JSON' }); }
            const fields = ['id', 'course', 'name', 'ms', 'achievedAt'];
            if (!body || Array.isArray(body) || typeof body !== 'object' ||
                Object.keys(body).length !== fields.length || !fields.every(field => Object.hasOwn(body, field)) ||
                typeof body.id !== 'string' || !idPattern.test(body.id) ||
                typeof body.course !== 'string' || !coursePattern.test(body.course) ||
                typeof body.name !== 'string' || !/^[A-Z0-9._-]{1,3}$/.test(body.name) ||
                !Number.isInteger(body.ms) || body.ms < 1 || body.ms > 5999999 ||
                !Number.isInteger(body.achievedAt) || body.achievedAt < earliestAchievement || body.achievedAt > Math.floor(now() / 1000) + 300) {
                return send(res, 400, { error: 'Invalid score fields' });
            }
            // Canonicalize both accepted UUID spellings to the same idempotency key.
            const id = body.id.replaceAll('-', '').toLowerCase();
            const existing = byId.get(id);
            if (existing) return send(res, 200, existing);
            insert.run(id, body.course, body.name, body.ms, platform, body.achievedAt);
            return send(res, 201, byId.get(id));
        } catch (error) {
            console.error(error.message);
            if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
            else res.destroy();
        }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.once('close', () => db.close());
    return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const server = createApp();
    server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Highscores service listening'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
