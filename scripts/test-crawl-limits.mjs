// Run: node --import tsx scripts/test-crawl-limits.mjs
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { REQUEST_LIMIT_LUA } from '../lib/crawl-limits.ts';
const name = `crawlproof-rate-test-${process.pid}`;
let redis;
try {
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::6379', 'redis:8-alpine'], { stdio: 'pipe' });
  const mapping = execFileSync('docker', ['port', name, '6379/tcp'], { encoding: 'utf8' }).trim();
  redis = new Redis(`redis://${mapping}`, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
  const args = ['semrushbot:ad', 3600, 12, 60_000, 600, 3_600_000];
  const keys = ['test:ip', 'test:family', 'test:metrics'];
  const claim = () => redis.eval(REQUEST_LIMIT_LUA, keys.length, ...keys, ...args);
  const concurrent = await Promise.all(Array.from({ length: 30 }, claim));
  assert.equal(concurrent.filter((x) => x === 0).length, 12, 'atomic IP admission');
  assert.equal(concurrent.filter((x) => x > 0).length, 18, 'excess requests rejected');
  assert.equal(await redis.hget('test:metrics', 'semrushbot:ad:requests'), '30');
  assert.equal(await redis.hget('test:metrics', 'semrushbot:ad:throttled'), '18');
  const before = await redis.pttl('test:ip');
  await claim();
  assert.ok(await redis.pttl('test:ip') <= before, 'rejects must not extend the deadline');
  await redis.set('test:family', '600', 'PX', 3_600_000);
  const acrossIps = await redis.eval(REQUEST_LIMIT_LUA, 3, 'test:other-ip', 'test:family', 'test:metrics', ...args);
  assert.ok(acrossIps > 60_000, 'rotating IPs must still hit family budget');
  console.log('Redis atomic concurrency, bounded counters, fixed deadlines and family throttling passed.');
} finally {
  if (redis) redis.disconnect();
  try { execFileSync('docker', ['stop', name], { stdio: 'pipe' }); } catch {}
}
