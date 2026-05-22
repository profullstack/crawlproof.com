// Primitives for pushing changes to a customer repo through the GitHub
// App installation token. Composable for Install Tracker (deterministic
// edits) and Apply Fix (Claude-generated edits).

const GH_API = "https://api.github.com";

interface AuthedInit extends RequestInit {
  token: string;
}

async function gh(path: string, init: AuthedInit): Promise<Response> {
  const { token, headers, ...rest } = init;
  return fetch(`${GH_API}${path}`, {
    ...rest,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "CrawlProof/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      ...(headers || {}),
    },
  });
}

export interface RepoMeta {
  default_branch: string;
  full_name: string;
  private: boolean;
  id: number;
}

export async function getRepo(input: {
  token: string;
  owner: string;
  repo: string;
}): Promise<RepoMeta> {
  const res = await gh(`/repos/${input.owner}/${input.repo}`, {
    token: input.token,
  });
  if (!res.ok) {
    throw new Error(`getRepo ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as RepoMeta;
}

interface ContentResponse {
  sha: string;
  // Always base64-encoded; line-wrapped on GitHub's side.
  content: string;
  encoding: "base64";
  path: string;
  type: "file";
}

export interface FileContent {
  path: string;
  sha: string;
  content: string;
}

/**
 * Fetch a file's content + blob sha from the default branch (or a named
 * ref). Returns null on 404 so callers can probe a list of candidate
 * paths without try/catch noise.
 */
export async function getFileContent(input: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}): Promise<FileContent | null> {
  const url = `/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(
    input.path,
  )}${input.ref ? `?ref=${encodeURIComponent(input.ref)}` : ""}`;
  const res = await gh(url, { token: input.token });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`getFileContent ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as ContentResponse | ContentResponse[];
  // A directory returns an array; we treat that as "not a file".
  if (Array.isArray(body)) return null;
  if (body.type !== "file" || body.encoding !== "base64") return null;
  const decoded = Buffer.from(body.content, "base64").toString("utf-8");
  return { path: body.path, sha: body.sha, content: decoded };
}

interface BranchRef {
  ref: string;
  object: { sha: string };
}

async function getBranchSha(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}): Promise<string> {
  const res = await gh(
    `/repos/${input.owner}/${input.repo}/git/ref/heads/${encodeURIComponent(input.branch)}`,
    { token: input.token },
  );
  if (!res.ok) {
    throw new Error(`getBranchSha ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as BranchRef;
  return body.object.sha;
}

export async function createBranch(input: {
  token: string;
  owner: string;
  repo: string;
  newBranch: string;
  fromBranch: string;
}): Promise<{ created: boolean }> {
  const baseSha = await getBranchSha({
    token: input.token,
    owner: input.owner,
    repo: input.repo,
    branch: input.fromBranch,
  });
  const res = await gh(`/repos/${input.owner}/${input.repo}/git/refs`, {
    token: input.token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: `refs/heads/${input.newBranch}`,
      sha: baseSha,
    }),
  });
  if (res.status === 201) return { created: true };
  // 422 with "Reference already exists" is fine — we'll just push onto it.
  if (res.status === 422) {
    const t = await res.text();
    if (/already exists/i.test(t)) return { created: false };
    throw new Error(`createBranch 422: ${t}`);
  }
  throw new Error(`createBranch ${res.status}: ${await res.text()}`);
}

interface PutFileResponse {
  content: { sha: string; path: string };
  commit: { sha: string };
}

export async function putFile(input: {
  token: string;
  owner: string;
  repo: string;
  path: string;
  branch: string;
  message: string;
  contentUtf8: string;
  /** Required when updating an existing file; omit for new files. */
  sha?: string;
}): Promise<PutFileResponse> {
  const res = await gh(
    `/repos/${input.owner}/${input.repo}/contents/${encodeURIComponent(input.path)}`,
    {
      token: input.token,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: input.message,
        content: Buffer.from(input.contentUtf8, "utf-8").toString("base64"),
        branch: input.branch,
        sha: input.sha,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`putFile ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PutFileResponse;
}

interface PullRequest {
  number: number;
  html_url: string;
  state: string;
}

export async function openPullRequest(input: {
  token: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<PullRequest> {
  const res = await gh(`/repos/${input.owner}/${input.repo}/pulls`, {
    token: input.token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      maintainer_can_modify: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`openPullRequest ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PullRequest;
}
