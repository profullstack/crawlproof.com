import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const name = `crawlproof-earnings-test-${process.pid}`;
try {
  execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine'], { stdio: 'pipe' });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { execFileSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'pipe' }); ready = true; break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  if (!ready) throw new Error('Test database did not start');
  const migration = readFileSync(new URL('../supabase/migrations/20260913170000_ad_token_earnings.sql', import.meta.url), 'utf8');
  const fixture = readFileSync(new URL('../tests/sql/ad-token-earnings.sql', import.meta.url), 'utf8');
  execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: fixture.replace('-- APPLY MIGRATION HERE', migration), stdio: ['pipe', 'inherit', 'inherit'] });
  console.log('Owner isolation, role permissions, reporting windows and click accounting passed.');
} finally {
  try { execFileSync('docker', ['stop', name], { stdio: 'pipe' }); } catch {}
}
