import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const PROTECTED_PATH_PATTERNS = [
  /^\.env(\..+)?$/,
  /\.pem$/,
  /\.key$/,
  /^\.github\/workflows\//,
  /^node_modules\//,
];

const PR_LABEL = "docs-agent";

export function openDocsPullRequest({
  docsRepoRoot,
  docsRepo,
  docsRepoToken,
  decision,
  docsPath,
  patchedContent,
  reasoning,
  commit,
  affectedSources,
  dryRun = false,
}) {
  if (decision !== "UPDATE" && decision !== "HUMAN_NEEDED") {
    throw new Error(`openDocsPullRequest only handles UPDATE and HUMAN_NEEDED, received ${decision}`);
  }

  const slug = makeSlug(docsPath);
  const branch = `docs-agent/${commit.shortSha}/${slug}`;
  const title = decision === "UPDATE"
    ? `Docs update for ${commit.shortSha}: ${docsPath}`
    : `Docs follow-up needed for ${commit.shortSha}: ${docsPath}`;

  const targetPath = decision === "UPDATE"
    ? docsPath
    : path.posix.join("agent-followups", `${commit.shortSha}-${slug}.md`);

  assertSafeTargetPath(targetPath);

  const body = renderPrBody({ decision, docsPath, reasoning, commit, affectedSources, targetPath });

  if (dryRun) {
    return {
      dryRun: true,
      branch,
      title,
      targetPath,
      decision,
    };
  }

  const defaultBranch = resolveDefaultBranch({ docsRepoRoot, docsRepo, docsRepoToken });

  git(docsRepoRoot, ["fetch", "origin", defaultBranch]);
  git(docsRepoRoot, ["switch", "-C", branch, `origin/${defaultBranch}`]);

  const absoluteTarget = path.join(docsRepoRoot, targetPath);
  mkdirSync(path.dirname(absoluteTarget), { recursive: true });
  if (decision === "UPDATE") {
    writeFileSync(absoluteTarget, ensureTrailingNewline(patchedContent));
  } else {
    writeFileSync(absoluteTarget, renderFollowupNote({ docsPath, reasoning, commit, affectedSources }));
  }

  const status = gitOutput(docsRepoRoot, ["status", "--porcelain"]);
  if (!status.trim()) {
    return { skipped: true, reason: "no changes after writing target file", branch, targetPath };
  }

  git(docsRepoRoot, ["add", "--", targetPath]);
  git(docsRepoRoot, [
    "-c",
    "user.name=node-docs-agent",
    "-c",
    "user.email=node-docs-agent@users.noreply.github.com",
    "commit",
    "-m",
    title,
  ]);
  git(docsRepoRoot, ["push", "--set-upstream", "origin", branch, "--force-with-lease"]);

  const bodyPath = path.join(docsRepoRoot, ".git", `docs-agent-${commit.shortSha}-${slug}.md`);
  writeFileSync(bodyPath, body);

  const ghEnv = withGhEnv(docsRepoToken);
  const existingPr = ghOutput([
    "pr",
    "list",
    "--repo",
    docsRepo,
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ], { env: ghEnv });

  let prRef;
  if (existingPr) {
    gh(["pr", "edit", existingPr, "--repo", docsRepo, "--title", title, "--body-file", bodyPath], {
      env: ghEnv,
    });
    prRef = existingPr;
  } else {
    prRef = ghOutput([
      "pr",
      "create",
      "--repo",
      docsRepo,
      "--head",
      branch,
      "--base",
      defaultBranch,
      "--title",
      title,
      "--body-file",
      bodyPath,
    ], { env: ghEnv });
  }

  const labelResult = spawnSync("gh", ["pr", "edit", prRef, "--repo", docsRepo, "--add-label", PR_LABEL], {
    env: ghEnv,
    stdio: "inherit",
  });
  const labelApplied = labelResult.status === 0;

  return {
    branch,
    title,
    targetPath,
    decision,
    pullRequest: prRef,
    labelApplied,
  };
}

function assertSafeTargetPath(targetPath) {
  const normalized = path.posix.normalize(targetPath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new Error(`Refusing to write to unsafe docs path: ${targetPath}`);
  }
  for (const pattern of PROTECTED_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      throw new Error(`Refusing to write generated change to protected path: ${targetPath}`);
    }
  }
}

function resolveDefaultBranch({ docsRepoRoot, docsRepo, docsRepoToken }) {
  const fromGh = ghOutput([
    "repo",
    "view",
    docsRepo,
    "--json",
    "defaultBranchRef",
    "--jq",
    ".defaultBranchRef.name",
  ], { env: withGhEnv(docsRepoToken), allowFailure: true });
  if (fromGh) return fromGh;

  const symbolic = gitOutput(docsRepoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"], { allowFailure: true });
  const match = symbolic.match(/^refs\/remotes\/origin\/(.+)$/);
  return match ? match[1] : "main";
}

function renderPrBody({ decision, docsPath, reasoning, commit, affectedSources, targetPath }) {
  const sourcesList = affectedSources.length > 0
    ? affectedSources.map((file) => `- \`${file}\``).join("\n")
    : "- (no source files matched)";

  if (decision === "UPDATE") {
    return [
      "## Summary",
      reasoning,
      "",
      "## Source Change",
      `- Source repository: ${commit.sourceRepo}`,
      `- Source commit: ${commit.shortSha}`,
      `- Compare: ${commit.commitUrl}`,
      `- Commit title: ${commit.commitTitle || "unknown"}`,
      "",
      "## Docs File Updated",
      `- \`${docsPath}\``,
      "",
      "## Source Files That Triggered The Update",
      sourcesList,
      "",
      "## Reviewer Checklist",
      "- [ ] Verify the patched docs match the actual source change.",
      "- [ ] Confirm tone, frontmatter, and Mintlify components were preserved.",
      "- [ ] Confirm no secrets, placeholders, or TODOs were introduced.",
      "",
      "Generated by the node docs agent.",
    ].join("\n");
  }

  return [
    "## Summary",
    "Human review needed. The docs agent could not safely propose a patch for this docs file.",
    "",
    "## Reasoning",
    reasoning,
    "",
    "## Source Change",
    `- Source repository: ${commit.sourceRepo}`,
    `- Source commit: ${commit.shortSha}`,
    `- Compare: ${commit.commitUrl}`,
    `- Commit title: ${commit.commitTitle || "unknown"}`,
    "",
    "## Docs File Under Review",
    `- \`${docsPath}\``,
    "",
    "## Source Files That Triggered The Review",
    sourcesList,
    "",
    "## Follow-Up Note",
    `A placeholder note was committed at \`${targetPath}\` so this PR has a reviewable diff. Replace it with the real docs change or close the PR if no docs change is needed.`,
    "",
    "Generated by the node docs agent.",
  ].join("\n");
}

function renderFollowupNote({ docsPath, reasoning, commit, affectedSources }) {
  return [
    "# Docs Agent Follow-Up",
    "",
    `- Source repository: ${commit.sourceRepo}`,
    `- Source commit: ${commit.shortSha}`,
    `- Compare: ${commit.commitUrl}`,
    `- Commit title: ${commit.commitTitle || "unknown"}`,
    `- Docs file under review: \`${docsPath}\``,
    "",
    "## Source Files That Triggered The Review",
    affectedSources.map((file) => `- \`${file}\``).join("\n") || "- (none)",
    "",
    "## Reasoning",
    reasoning,
    "",
    "Replace this note with the real docs update, or close the related PR if no update is needed.",
    "",
  ].join("\n");
}

function makeSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "docs";
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function withGhEnv(token) {
  if (!token) return process.env;
  return { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
}

function git(cwd, args) {
  execFileSync("git", args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}

function gitOutput(cwd, args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}

function gh(args, options = {}) {
  const result = spawnSync("gh", args, {
    env: options.env || process.env,
    stdio: "inherit",
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`gh ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function ghOutput(args, options = {}) {
  try {
    return execFileSync("gh", args, {
      env: options.env || process.env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}
