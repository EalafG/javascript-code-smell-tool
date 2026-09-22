import assert from "node:assert/strict";
import test from "node:test";
import {
  importPublicGitHubRepository,
  parseGitHubRepositoryUrl,
  selectJavaScriptTreeEntries,
} from "../app/github-import.ts";

test("parses canonical GitHub repository and tree URLs", () => {
  assert.deepEqual(parseGitHubRepositoryUrl("https://github.com/example/research-tool.git"), {
    owner: "example",
    repository: "research-tool",
    repositoryUrl: "https://github.com/example/research-tool",
    embeddedRef: "",
  });
  assert.equal(
    parseGitHubRepositoryUrl("github.com/example/research-tool/tree/feature/import").embeddedRef,
    "feature/import",
  );
  assert.throws(() => parseGitHubRepositoryUrl("https://example.com/example/research-tool"), /github\.com/);
});

test("selects supported blobs and preserves repository-relative paths", () => {
  const selected = selectJavaScriptTreeEntries([
    { path: "src/index.js", type: "blob", size: 23 },
    { path: "src/module.mjs", type: "blob", size: 18 },
    { path: "README.md", type: "blob", size: 50 },
    { path: "src", type: "tree" },
  ], "example-tool");

  assert.deepEqual(selected.map(({ relativePath, size }) => ({ relativePath, size })), [
    { relativePath: "example-tool/src/index.js", size: 23 },
    { relativePath: "example-tool/src/module.mjs", size: 18 },
  ]);
});

test("resolves a ref, reads its tree, and downloads files at the exact commit", async () => {
  const sha = "a".repeat(40);
  const requestedUrls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/repos/example/example-tool")) {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (url.endsWith("/commits/release-1")) {
      return new Response(JSON.stringify({ sha }), { status: 200 });
    }
    if (url.includes(`/git/trees/${sha}?recursive=1`)) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [
          { path: "src/index.jsx", type: "blob", size: 37 },
          { path: "README.md", type: "blob", size: 100 },
        ],
      }), { status: 200 });
    }
    if (url === `https://raw.githubusercontent.com/example/example-tool/${sha}/src/index.jsx`) {
      return new Response("export const View = () => <main />;", { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const progress: string[] = [];

  const imported = await importPublicGitHubRepository(
    "https://github.com/example/example-tool",
    "release-1",
    fetcher,
    ({ completed, total }) => progress.push(`${completed}/${total}`),
  );

  assert.equal(imported.requestedRef, "release-1");
  assert.equal(imported.resolvedCommitSha, sha);
  assert.equal(imported.provenance, `github:example/example-tool@${sha}`);
  assert.equal(imported.files[0].relativePath, "example-tool/src/index.jsx");
  assert.equal(new TextDecoder().decode(imported.files[0].bytes), "export const View = () => <main />;");
  assert.deepEqual(progress, ["0/1", "1/1"]);
  assert.ok(requestedUrls.some((url) => url.includes(`/git/trees/${sha}?recursive=1`)));
});

test("rejects a truncated repository tree instead of silently importing a partial corpus", async () => {
  const sha = "b".repeat(40);
  const responses = [
    new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
    new Response(JSON.stringify({ sha }), { status: 200 }),
    new Response(JSON.stringify({ truncated: true, tree: [] }), { status: 200 }),
  ];
  const fetcher: typeof fetch = async () => responses.shift() ?? new Response(null, { status: 500 });

  await assert.rejects(
    importPublicGitHubRepository("https://github.com/example/example-tool", "", fetcher),
    /truncated/i,
  );
});
