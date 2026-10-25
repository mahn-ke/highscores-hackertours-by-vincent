import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApp } from './main.js';

const issuer = 'https://keycloak.example/realms/test';
const nowSeconds = 1792956000;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'local', alg: 'RS256', use: 'sig' };
const jwks = createLocalJWKSet({ keys: [jwk] });
const token = async (azp = 'console-3ds', changes = {}) => new SignJWT({ azp, ...changes })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' }).setIssuer(issuer)
    .setSubject('service-account-console').setIssuedAt(nowSeconds).setExpirationTime(nowSeconds + 3600)
    .sign(privateKey);
const valid = { id: '12345678-1234-1234-1234-123456789abc', course: 'ccchh', name: 'VIM', ms: 12345, achievedAt: nowSeconds };
async function fixture(t, options = {}) {
    const server = createApp({ databasePath: ':memory:', issuer, console3ds: 'console-3ds', consoleXbox: 'console-xbox', jwks, now: () => nowSeconds * 1000, ...options });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.listening ? new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) : undefined);
    const base = `http://127.0.0.1:${server.address().port}`;
    const defaultToken = await token();
    const post = async (body = valid, accessToken = defaultToken, headers = {}) => fetch(`${base}/api/scores`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...headers }, body: JSON.stringify(body),
    });
    return { server, base, post };
}

test('public endpoints, ranking, platform attribution and idempotency', async t => {
    const { base, post } = await fixture(t);
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok' });
    assert.equal((await (await fetch(`${base}/openapi.json`)).json()).openapi, '3.0.3');
    assert.deepEqual(await (await fetch(`${base}/api/scores/unknown`)).json(), []);
    const created = await post();
    assert.equal(created.status, 201);
    const row = await created.json();
    assert.equal(row.platform, '3ds');
    assert.equal(row.id, valid.id.replaceAll('-', ''));
    const duplicate = await post({ ...valid, name: 'NEW', id: row.id.toUpperCase() });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), row);
    assert.equal((await post({ ...valid, id: 'b'.repeat(32), achievedAt: nowSeconds - 1 }, await token('console-xbox'))).status, 201);
    assert.equal((await post({ ...valid, id: 'c'.repeat(32), ms: 1000 })).status, 201);
    assert.equal((await post({ ...valid, id: 'd'.repeat(32), course: 'another' })).status, 201);
    const scores = await (await fetch(`${base}/api/scores/ccchh`)).json();
    assert.deepEqual(scores.map(s => [s.ms, s.platform]), [[1000, '3ds'], [12345, 'xbox'], [12345, '3ds']]);
    assert.deepEqual(Object.keys(scores[0]).sort(), ['achievedAt', 'ms', 'name', 'platform']);
    assert.equal((await (await fetch(`${base}/api/scores/ccchh?limit=1`)).json()).length, 1);
    assert.deepEqual(await (await fetch(`${base}/api/courses`)).json(), [{ course: 'another', count: 1, bestMs: 12345 }, { course: 'ccchh', count: 3, bestMs: 1000 }]);
});

test('reject malformed submissions and invalid limits without inserting rows', async t => {
    const { base, post } = await fixture(t);
    const cases = [null, [], 1, {}, { ...valid, extra: true }, { ...valid, platform: '3ds' },
        ...['', 'abcd', 12].map(id => ({ ...valid, id })),
        ...['UPPER', '../oops', 'a'.repeat(32), null].map(course => ({ ...valid, course })),
        ...['', 'abcd', 'abc', 'A B', '😀', 1].map(name => ({ ...valid, name })),
        ...[0, 6000000, 1.5, '12345', null].map(ms => ({ ...valid, ms })),
        ...[0, 1577836799, nowSeconds + 301, 1.5, '1792956000'].map(achievedAt => ({ ...valid, achievedAt }))];
    for (const body of cases) assert.equal((await post(body)).status, 400, JSON.stringify(body));
    assert.equal((await post(valid, await token(), { 'Content-Type': 'text/plain' })).status, 400);
    for (const path of ['CCCHH', '%ZZ', 'ccchh?limit=0', 'ccchh?limit=-1', 'ccchh?limit=1.2', 'ccchh?limit=', 'ccchh?limit=9007199254740992', 'ccchh?limit=1&limit=2']) {
        assert.equal((await fetch(`${base}/api/scores/${path}`)).status, 400, path);
    }
    assert.deepEqual(await (await fetch(`${base}/api/courses`)).json(), []);
    const auth = await token();
    for (const body of ['{', ' '.repeat(4097)]) {
        assert.equal((await fetch(`${base}/api/scores`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` }, body })).status, 400);
    }
});

test('requires valid signed, unexpired issuer-matched tokens and allowed azp', async t => {
    const { post } = await fixture(t);
    assert.equal((await post(valid, '')).status, 401);
    assert.equal((await post(valid, 'garbage')).status, 401);
    assert.equal((await post(valid, await token('unknown'))).status, 403);
    const sign = (payload, key = privateKey) => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'local' }).sign(key);
    const payload = { iss: issuer, sub: 'service-account', iat: nowSeconds, exp: nowSeconds + 60, azp: 'console-3ds' };
    for (const changes of [{ iss: 'https://wrong.example' }, { exp: nowSeconds - 1 }, { exp: undefined }, { azp: undefined }, { sub: undefined }, { iat: undefined }, { nbf: nowSeconds + 300 }]) {
        assert.equal((await post(valid, await sign({ ...payload, ...changes }))).status, 401);
    }
    const wrongKey = await generateKeyPair('RS256');
    assert.equal((await post(valid, await sign(payload, wrongKey.privateKey))).status, 401);
    assert.equal((await post()).status, 201);
});

test('rate limit is per authorized client and resets next minute', async t => {
    let clock = nowSeconds * 1000;
    const { post } = await fixture(t, { rateLimit: 1, now: () => clock });
    assert.equal((await post()).status, 201);
    const limited = await post();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    assert.equal((await post({ ...valid, id: 'e'.repeat(32) }, await token('console-xbox'))).status, 201);
    clock += 60000;
    assert.equal((await post()).status, 200);
});

test('SQLite survives closing and reopening the service', async t => {
    const directory = `.test-data-${process.pid}`;
    mkdirSync(directory);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const databasePath = `${directory}/scores.sqlite`;
    const first = await fixture(t, { databasePath });
    assert.equal((await first.post()).status, 201);
    await new Promise(resolve => { first.server.closeAllConnections(); first.server.close(resolve); });
    const second = await fixture(t, { databasePath });
    assert.equal((await second.post()).status, 200);
});

test('fails closed when console client configuration is missing or ambiguous', () => {
    for (const ids of [{ console3ds: '', consoleXbox: 'x' }, { console3ds: 'same', consoleXbox: 'same' }]) {
        assert.throws(() => createApp({ databasePath: ':memory:', ...ids }), /Two distinct/);
    }
});
