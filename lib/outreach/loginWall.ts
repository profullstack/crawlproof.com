// Tell a login wall apart from an empty directory.
//
// Both look identical to seed discovery: HTTP 200, a page, and no business
// links on it. Reporting "no businesses found" for a site that simply wanted
// a login sends the user off to debug their search terms when the actual
// problem is that they were never shown the page.
//
// Instagram is the motivating case and a good illustration of why status
// codes are useless here — asking for a search page returns 200, having
// quietly redirected to /accounts/login/?next=<the page you asked for>.
//
// Kept dependency-free so both the fetch path and the render path can use it:
// a redirect is visible to plain fetch, while a password field on a
// JS-rendered login screen only appears once scripts have run.

/** Paths a site sends you to when it wants credentials. */
const LOGIN_PATH_RE =
  /(^|\/)(accounts\/login|login|log-in|signin|sign-in|sign_in|auth\/login|users\/sign_in|session\/new|checkpoint)(\/|$|\?)/i;

/**
 * Query parameters a login page uses to remember where you were going.
 * Their presence alongside a login path is what distinguishes "you were
 * bounced here" from "you asked for the login page".
 */
const RETURN_PARAM_RE = /[?&](next|return_to|returnurl|redirect(_uri|_to)?|continue|dest|destination)=/i;

const PASSWORD_INPUT_RE = /<input[^>]+type=["']password["']/i;

/** Phrases that accompany a credential form rather than ordinary page copy. */
const LOGIN_COPY_RE =
  /(forgot (your )?password|log in to continue|sign in to continue|please log in|login required|create an account to)/i;

export type LoginWallVerdict = {
  loginRequired: boolean;
  /** Why we think so — surfaced to the user so the call is auditable. */
  reason: string | null;
};

/**
 * Decide whether `html` (fetched from `finalUrl`, having been asked for
 * `requestedUrl`) is a login wall.
 *
 * The strongest signal is a redirect off the requested page onto a login
 * path, because that is the site explicitly refusing the request. A password
 * field is next: ordinary directory pages don't carry one. Login copy alone
 * is not enough — plenty of real pages have a "log in" link in the header —
 * so it only counts as corroboration for a page that also moved us.
 */
export function looksLikeLoginWall(input: {
  requestedUrl: string;
  finalUrl?: string;
  html?: string;
}): LoginWallVerdict {
  const requested = safeUrl(input.requestedUrl);
  const final = safeUrl(input.finalUrl ?? input.requestedUrl);

  const movedUs =
    Boolean(final && requested) &&
    (final!.pathname !== requested!.pathname || final!.host !== requested!.host);

  const finalIsLoginPath = final ? LOGIN_PATH_RE.test(final.pathname) : false;
  const carriesReturn = final ? RETURN_PARAM_RE.test(final.search) : false;

  // Redirected onto a login path: unambiguous.
  if (movedUs && finalIsLoginPath) {
    return {
      loginRequired: true,
      reason: carriesReturn
        ? `redirected to ${final!.pathname} carrying the page you asked for as a return parameter`
        : `redirected to ${final!.pathname}`,
    };
  }

  const html = input.html ?? "";
  const hasPasswordField = PASSWORD_INPUT_RE.test(html);

  // A password field on the page we were served, when we asked for something
  // that was not a login page.
  if (hasPasswordField && !(requested && LOGIN_PATH_RE.test(requested.pathname))) {
    return {
      loginRequired: true,
      reason: movedUs
        ? `served a password field after redirecting to ${final?.pathname ?? "another page"}`
        : "the page contains a password field",
    };
  }

  // Moved us somewhere that reads like a login screen without matching a
  // known login path — covers hosts with unusual routes.
  if (movedUs && LOGIN_COPY_RE.test(html)) {
    return {
      loginRequired: true,
      reason: `redirected to ${final?.pathname ?? "another page"}, which reads like a sign-in screen`,
    };
  }

  return { loginRequired: false, reason: null };
}

function safeUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
