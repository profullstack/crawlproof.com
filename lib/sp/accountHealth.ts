// Shared health rules for connected social accounts.
//
// Deliberately dependency-free: both the Next server (lib/sp/post.ts) and the
// Playwright worker (lib/sp/browserPost.ts) import this, and the server must
// not pull the browser stack into its bundle to read one number.

/**
 * How many consecutive posting failures an account may rack up before we stop
 * posting to it and ask the user to reconnect.
 *
 * The browser path recognises a dead session by its login wall, but that only
 * catches a *recognised* failure. When a site redesigns and a selector stops
 * matching, every attempt fails with a plain timeout instead, nothing flags the
 * account, and the worker keeps driving a browser at it every cadence tick
 * forever. One Reddit account reached 2,953 consecutive failures and 0
 * successes that way, because nothing ever read the counter it was
 * incrementing.
 */
export const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Whether this failure should take the account out of rotation.
 *
 * `token_expired` is the status the UI already renders as "reconnect", and
 * account selection only ever picks up `active` rows, so setting it both stops
 * the retries and tells the user why.
 */
export function shouldDisableAccount(args: {
  consecutiveFailures: number;
  sessionExpired?: boolean;
}): boolean {
  return (
    Boolean(args.sessionExpired) || args.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
  );
}
