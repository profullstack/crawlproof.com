# PRD: git.profullstack.com, moving the fleet off GitHub to self-hosted Gitea

Status: draft, not scheduled. Written 2026-09-24 alongside the crawlproof.com
move to dev2, because that move is the first time every deploy path in a repo
stopped depending on a vendor.

This is fleet-wide and only lives in the crawlproof repo because that is where
the work that prompted it happened. Move it to cli-tools when it gets picked up.

## Why

The Fleet SysOps Manifesto already says bare metal over managed platforms, God
Mode keys in the vault, and automate everything. Source control is the last
large dependency that is still somebody else's service, and it is the one that
every other system is downstream of: CI, deploys, releases, issue tracking, and
the agent tooling that reads and writes repos all terminate at GitHub.

Concretely, the pull is:

1. **CI minutes and their ceiling.** Jobs killed at their timeout look exactly
   like flaky tests, which has already cost real debugging time. Our own
   runners on our own boxes have our CPU count and no per-minute meter.
2. **One account is one blast radius.** A suspended org takes every deploy
   pipeline in the fleet with it.
3. **Agents are the primary users now.** Most commits and PRs here are opened
   by tooling. An API we control can be shaped for that instead of worked
   around with rate limit backoff.
4. **It is the same shape of work we just did.** dev2 already runs Docker,
   nginx, certbot and a self-hosted Postgres. Gitea is one more compose stack.

## Non-goals for v1

- Replacing GitHub entirely on day one. Public repos stay mirrored to GitHub
  for discovery, npm provenance, and anything that links to a github.com URL.
- Migrating GitHub Discussions, Projects, or Sponsors.
- Moving the published npm packages or their release flow.
- Anything about the `malware-test-prs` or CodeQL setups, which are GitHub
  security features with no Gitea equivalent.

## Scope

Roughly 150 repositories across `profullstack` and `ralyodio`, of which about
60 are live properties. Per repo we need code, tags, releases, issues, pull
requests, labels, milestones, wikis and webhooks.

The hard part is not the repos. It is the **deploy workflows**: every property
that deploys itself does so from `.github/workflows`, and each one has to keep
working through the move.

## Architecture

- **Host.** Its own box, not dev2. Source control going down must not be
  correlated with an app server going down. Same provisioning path as dev2
  (`root-ubuntu.sh`, nginx, certbot, Docker).
- **Gitea** in Docker, pinned by tag, behind nginx at `git.profullstack.com`.
- **Postgres** as its database, self-hosted, its own instance rather than
  sharing an app's.
- **SSH** on 22 for git, which means the box's own sshd moves to another port
  or Gitea's SSH runs on a second address. Decide before provisioning, because
  changing it later invalidates every cloned remote.
- **Gitea Actions** with `act_runner`, which speaks the GitHub Actions workflow
  syntax. This is the single biggest compatibility question and the thing to
  spike first.
- **Object storage** for LFS and attachments, on the local disk to start.
- **Auth** is OAuth 2.1 with PKCE plus passkeys, per house rule. No passwords.
- **Backups** are `gitea dump` plus a Postgres dump, offsite, verified by
  restoring into a scratch instance. Unlike an app, there is no upstream copy
  to re-derive this from once GitHub is no longer authoritative.

## `tea` CLI

`tea` is Gitea's official CLI and is the intended automation surface: logins,
repos, issues, PRs, releases, and org management. It becomes the house
equivalent of `gh`, which means the fleet's scripts that shell out to `gh`
(`gh-prs`, `gh-issues`, `gh-prs-merge`, `gh-pulse` and friends in `~/scripts`)
need a `tea` path. Wrapping both behind one house command is likely better than
rewriting each script twice.

## Migration mechanics

Gitea's migration API pulls a GitHub repo including issues, PRs, releases,
labels and milestones, given a GitHub token. That is one API call per repo and
is scriptable over the whole list.

Order:

1. Stand up Gitea, restore a backup into a scratch instance to prove backups
   work before anything depends on it.
2. Migrate one low-traffic repo end to end, including a deploy.
3. Spike Gitea Actions against the three workflow shapes we actually use:
   a plain test matrix, an ssh deploy (like `deploy-dev2.yml`), and a release
   that publishes to npm.
4. Bulk-migrate in waves, dormant repos first, live properties last.
5. For each live property, cut its deploy over and watch one real deploy before
   moving to the next.
6. Flip GitHub repos to mirrors, or archive them.

## Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Gitea Actions is not GitHub Actions | Every deploy in the fleet is a workflow file | Spike it in phase 3 before migrating anything live |
| We become our own uptime | A git outage blocks all shipping | Separate box, tested backups, GitHub mirrors kept warm |
| `gh`-based tooling breaks | Dozens of scripts and agent paths call `gh` | One wrapper over both CLIs, not a rewrite |
| npm provenance | Publishing attestations expect GitHub | Keep releases on GitHub, or drop provenance deliberately |
| SSH port collision | Git on 22 fights the box's own sshd | Decide at provisioning time, never after |
| Half-migrated fleet | Two sources of truth invites drift | Migrate in waves, each wave finished before the next |

## Success criteria

- Every live property deploys from git.profullstack.com with no GitHub involvement.
- A restore from backup into a scratch instance is demonstrated, not assumed.
- `tea` covers what the house scripts need from `gh`.
- Public repos still resolve on github.com as mirrors.
- No deploy outage longer than one deploy cycle for any property during the move.

## Open questions

- One box, or Gitea plus runners on separate boxes?
- Do the `ralyodio` personal repos come along, or stay on GitHub?
- Does CodeQL have a replacement we care about, or do we accept losing it?
- Is issue history worth migrating for dormant repos, or is code and tags enough?
