const SUPPORTED_EXTENSION = /\.(?:js|mjs|cjs|jsx)$/i;
const MAX_REPOSITORY_FILES = 5_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 8;

export type GitHubRepositoryReference = {
  owner: string;
  repository: string;
  repositoryUrl: string;
  embeddedRef: string;
};

export type GitHubTreeEntry = {
  path?: string;
  type?: string;
  size?: number;
  sha?: string;
};

export type GitHubArchiveFile = {
  fileName: string;
  relativePath: string;
  bytes: Uint8Array<ArrayBuffer>;
};

export type GitHubRepositoryImport = GitHubRepositoryReference & {
  requestedRef: string;
  resolvedCommitSha: string;
  provenance: string;
  files: GitHubArchiveFile[];
};

export type GitHubImportProgress = {
  completed: number;
  total: number;
};

function githubHeaders(): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function parseGitHubRepositoryUrl(value: string): GitHubRepositoryReference {
  const candidate = value.trim();
  if (!candidate) throw new Error("Enter a public GitHub repository URL.");

  let url: URL;
  try {
    url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  } catch {
    throw new Error("Enter a valid GitHub repository URL, such as https://github.com/owner/repository.");
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error("Only public repositories hosted on github.com are supported.");
  }

  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const owner = parts[0] ?? "";
  const repository = (parts[1] ?? "").replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("The GitHub URL must identify an owner and repository.");
  }

  const embeddedRef = parts[2] === "tree" && parts.length > 3 ? parts.slice(3).join("/") : "";
  return {
    owner,
    repository,
    repositoryUrl: `https://github.com/${owner}/${repository}`,
    embeddedRef,
  };
}

async function requireOk(response: Response, action: string): Promise<Response> {
  if (response.ok) return response;
  if (response.status === 403 || response.status === 429) {
    throw new Error(`GitHub API limit reached while ${action}. Try again later or download the repository and select its folder.`);
  }
  if (response.status === 404) {
    throw new Error(`GitHub could not find this public repository, ref, or source file while ${action}. Private repositories are not imported in the browser.`);
  }
  throw new Error(`GitHub returned HTTP ${response.status} while ${action}.`);
}

export function selectJavaScriptTreeEntries(tree: GitHubTreeEntry[], repository: string): Array<{
  fileName: string;
  path: string;
  relativePath: string;
  size: number;
}> {
  const unique = new Map<string, { fileName: string; path: string; relativePath: string; size: number }>();
  for (const entry of tree) {
    const path = (entry.path ?? "").replace(/\\/g, "/");
    const parts = path.split("/").filter(Boolean);
    if (entry.type !== "blob" || !path || parts.includes("..") || !SUPPORTED_EXTENSION.test(path)) continue;
    const size = Math.max(0, entry.size ?? 0);
    unique.set(path, {
      fileName: parts.at(-1) ?? path,
      path,
      relativePath: `${repository}/${path}`,
      size,
    });
  }
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function rawFileUrl(owner: string, repository: string, sha: string, path: string): string {
  const encodedPath = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${sha}/${encodedPath}`;
}

export async function importPublicGitHubRepository(
  repositoryUrl: string,
  requestedRefInput = "",
  fetcher: typeof fetch = fetch,
  onProgress?: (progress: GitHubImportProgress) => void,
): Promise<GitHubRepositoryImport> {
  const reference = parseGitHubRepositoryUrl(repositoryUrl);
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}`;
  const repositoryResponse = await requireOk(await fetcher(apiBase, { headers: githubHeaders() }), "reading repository metadata");
  const repositoryData = await repositoryResponse.json() as { default_branch?: string };
  const requestedRef = requestedRefInput.trim() || reference.embeddedRef || repositoryData.default_branch || "HEAD";

  const commitResponse = await requireOk(
    await fetcher(`${apiBase}/commits/${encodeURIComponent(requestedRef)}`, { headers: githubHeaders() }),
    `resolving ref ${requestedRef}`,
  );
  const commitData = await commitResponse.json() as { sha?: string };
  const resolvedCommitSha = commitData.sha ?? "";
  if (!/^[0-9a-f]{40}$/i.test(resolvedCommitSha)) throw new Error("GitHub did not return a valid commit SHA for this ref.");

  const treeResponse = await requireOk(
    await fetcher(`${apiBase}/git/trees/${resolvedCommitSha}?recursive=1`, { headers: githubHeaders() }),
    "listing repository files",
  );
  const treeData = await treeResponse.json() as { tree?: GitHubTreeEntry[]; truncated?: boolean };
  if (treeData.truncated) {
    throw new Error("GitHub truncated this repository tree. Download the repository locally so no JavaScript files are silently omitted.");
  }
  const entries = selectJavaScriptTreeEntries(treeData.tree ?? [], reference.repository);
  if (!entries.length) throw new Error("No supported .js, .mjs, .cjs, or .jsx files were found in the repository.");
  if (entries.length > MAX_REPOSITORY_FILES) {
    throw new Error(`This repository contains ${entries.length.toLocaleString()} JavaScript files, above the ${MAX_REPOSITORY_FILES.toLocaleString()}-file browser import limit. Download it locally and analyze smaller folders separately.`);
  }
  const oversized = entries.filter((entry) => entry.size > MAX_FILE_BYTES);
  if (oversized.length) {
    throw new Error(`${oversized.length} JavaScript file${oversized.length === 1 ? " exceeds" : "s exceed"} the 16 MiB browser import limit. Download the repository locally so the analysis exclusion manifest can record oversized files.`);
  }
  const declaredTotal = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (declaredTotal > MAX_TOTAL_BYTES) {
    throw new Error("The JavaScript source in this repository exceeds the 150 MiB browser import limit. Download it locally and analyze smaller folders separately.");
  }

  const files = new Array<GitHubArchiveFile>(entries.length);
  let cursor = 0;
  let completed = 0;
  let downloadedBytes = 0;
  let downloadFailure: unknown = null;
  onProgress?.({ completed, total: entries.length });
  async function worker() {
    while (cursor < entries.length && !downloadFailure) {
      const index = cursor;
      cursor += 1;
      const entry = entries[index];
      try {
        const response = await requireOk(
          await fetcher(rawFileUrl(reference.owner, reference.repository, resolvedCommitSha, entry.path)),
          `downloading ${entry.path}`,
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        downloadedBytes += bytes.byteLength;
        if (bytes.byteLength > MAX_FILE_BYTES || downloadedBytes > MAX_TOTAL_BYTES) {
          throw new Error("The downloaded JavaScript source exceeds the browser import memory limit. Download the repository locally and analyze smaller folders separately.");
        }
        files[index] = {
          fileName: entry.fileName,
          relativePath: entry.relativePath,
          bytes,
        };
        completed += 1;
        onProgress?.({ completed, total: entries.length });
      } catch (error) {
        downloadFailure = error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, entries.length) }, () => worker()));
  if (downloadFailure) throw downloadFailure;

  return {
    ...reference,
    requestedRef,
    resolvedCommitSha: resolvedCommitSha.toLowerCase(),
    provenance: `github:${reference.owner}/${reference.repository}@${resolvedCommitSha.toLowerCase()}`,
    files,
  };
}
