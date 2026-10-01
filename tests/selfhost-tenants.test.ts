// setup-supabase.sh --print-tenants-sql is the pure half of --tenants-only:
// it turns tenants.conf into the SQL the live run applies to the shared
// supabase-db on dev2, without root or docker. Everything that could go wrong
// before the SQL reaches Postgres is checked here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../ops/selfhost/server/setup-supabase.sh");
const dir = mkdtempSync(path.join(tmpdir(), "tenants-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function render(dbs: string[], conf?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TENANTS_CONF;
  if (conf !== undefined) {
    const f = path.join(dir, `t${Math.random().toString(36).slice(2)}.conf`);
    writeFileSync(f, conf);
    env.TENANTS_CONF = f;
  }
  const r = spawnSync("bash", [SCRIPT, "--print-tenants-sql", ...dbs], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("tenants.conf as shipped", () => {
  it("gives the heavy tenants their own rows and everyone else the default", () => {
    const { code, out } = render(["rssamplifier", "nichedb", "d1sks_com"]);
    expect(code).toBe(0);
    expect(out).toMatch(/^begin;/);
    expect(out.trim()).toMatch(/commit;$/);
    expect(out).toContain('alter database "rssamplifier" connection limit 200;');
    expect(out).toContain('alter database "nichedb" connection limit 100;');
    expect(out).toContain('alter database "d1sks_com" connection limit 40;');
    expect(out).toContain(`alter role "postgres" in database "nichedb" set statement_timeout = '1h';`);
    expect(out).toContain(`alter role "postgres" in database "d1sks_com" set statement_timeout = '5min';`);
    // Unset lock_timeout is a RESET, so re-running after removing a value cleans up.
    expect(out).toContain('alter role "postgres" in database "d1sks_com" reset lock_timeout;');
  });

  it("leaves heavy tenants headroom over what they were measured using", () => {
    const { out } = render(["rssamplifier", "nichedb"]);
    const limit = (db: string) => Number(out.match(new RegExp(`"${db}" connection limit (\\d+)`))![1]);
    expect(limit("rssamplifier")).toBeGreaterThan(126 * 1.25);
    expect(limit("nichedb")).toBeGreaterThan(40 * 2);
  });

  it("never touches the shared databases", () => {
    const { code, out } = render(["postgres", "_supabase", "template1"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe("begin;\ncommit;");
  });
});

describe("tenants.conf validation", () => {
  const row = "* postgres 40 5min 10min -\n";

  it("requires a default row", () => {
    const r = render(["x"], "x postgres 1 1s 1s -\n");
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/no '\*' row/);
  });

  it("rejects a bare number as a duration (it would mean milliseconds)", () => {
    const r = render(["x"], "* postgres 40 300 10min -\n");
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/not a duration/);
  });

  it("rejects the shared databases, duplicates, and odd names", () => {
    expect(render(["x"], row + "postgres postgres 1 1s 1s -\n").err).toMatch(/shared infrastructure/);
    expect(render(["x"], row + "a postgres 1 1s 1s -\na postgres 2 1s 1s -\n").err).toMatch(/listed twice/);
    expect(render(["x"], row + 'a"b postgres 1 1s 1s -\n').err).toMatch(/bad database name/);
    expect(render(["x"], row + "a postgres 1 1s 1s\n").err).toMatch(/want 6 fields/);
  });

  it("ignores comments and maps '-' to unlimited / reset", () => {
    const r = render(["a"], "# note\n" + row + "a postgres - - 0 2s # trailing\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain('alter database "a" connection limit -1;');
    expect(r.out).toContain('alter role "postgres" in database "a" reset statement_timeout;');
    expect(r.out).toContain(`alter role "postgres" in database "a" set idle_in_transaction_session_timeout = '0';`);
    expect(r.out).toContain(`alter role "postgres" in database "a" set lock_timeout = '2s';`);
  });

  it("resets the other role's timeouts when a tenant moves to its own role", () => {
    const r = render(["a", "b"], row + "a a_app 10 30s 1min -\n");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`alter role "a_app" in database "a" set statement_timeout = '30s';`);
    expect(r.out).toContain('alter role "postgres" in database "a" reset statement_timeout;');
    expect(r.out).toContain(`alter role "postgres" in database "b" set statement_timeout = '5min';`);
  });
});
