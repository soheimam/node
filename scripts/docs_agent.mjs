#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { fetchDiff } from "./fetch_diff.mjs";
import { loadDocsMap, findAffectedDocs } from "./load_map.mjs";
import { callClaude } from "./call_claude.mjs";
import { openDocsPullRequest } from "./open_pr.mjs";

const args = parseArgs(process.argv.slice(2));
const dryRun = Boolean(args["dry-run"]);
const sourceRoot = path.resolve(args["source-root"] || process.cwd());
const docsRepoRoot = path.resolve(args["docs-repo-root"] || process.env.DOCS_REPO_ROOT || "docs-repo");
const docsMapPath = path.resolve(args["docs-map"] || path.join(sourceRoot, "docs-map.yml"));

const commitSha = required(process.env.COMMIT_SHA, "COMMIT_SHA");
const sourceRepo = required(process.env.SOURCE_REPO, "SOURCE_REPO");
const docsRepo = required(process.env.DOCS_REPO, "DOCS_REPO");

main().catch((error) => {
  log({
    level: "error",
    message: "Docs agent run failed",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

async function main() {
  log({
    level: "info",
    message: "Docs agent starting",
    source_repo: sourceRepo,
    docs_repo: docsRepo,
    commit_sha_short: commitSha.slice(0, 12),
    dry_run: dryRun,
  });

  if (!existsSync(docsMapPath)) {
    throw new Error(`docs-map not found at ${docsMapPath}`);
  }
  if (!dryRun && !existsSync(docsRepoRoot)) {
    throw new Error(`docs repository checkout not found at ${docsRepoRoot}`);
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const docsRepoToken = process.env.DOCS_REPO_TOKEN;
  if (!dryRun && !docsRepoToken) {
    throw new Error("DOCS_REPO_TOKEN is required to push branches and open PRs");
  }

  const commit = await fetchDiff({ sourceRepo, commitSha, githubToken });
  log({
    level: "info",
    message: "Fetched commit diff",
    commit_sha_short: commit.shortSha,
    changed_files_count: commit.changedFiles.length,
    diff_truncated: commit.diffWasTruncated,
  });

  if (commit.changedFiles.length === 0) {
    log({ level: "info", message: "Commit has no changed files; nothing to do" });
    return;
  }

  const docsMap = loadDocsMap(docsMapPath);
  const affected = findAffectedDocs({ docsMap, changedFiles: commit.changedFiles });

  if (affected.length === 0) {
    log({
      level: "info",
      message: "No docs files matched changed source paths",
      commit_sha_short: commit.shortSha,
    });
    return;
  }

  log({
    level: "info",
    message: "Affected docs files identified",
    docs_files_count: affected.length,
  });

  const apiKey = required(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY");

  const results = [];
  for (const { docsPath, sources } of affected) {
    const docsContent = readDocsFile({ docsRepoRoot, docsPath, dryRun });

    let decision;
    try {
      decision = await callClaude({
        apiKey,
        diff: commit.diff,
        commit,
        docsPath,
        docsContent,
        affectedSources: sources,
      });
    } catch (error) {
      log({
        level: "error",
        message: "Claude call failed for docs file",
        docs_file: docsPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    log({
      level: "info",
      message: "Claude decision recorded",
      docs_file: docsPath,
      decision: decision.decision,
    });

    if (decision.decision === "NO_CHANGE") {
      results.push({ docsPath, decision: decision.decision, skipped: true });
      continue;
    }

    const prResult = openDocsPullRequest({
      docsRepoRoot,
      docsRepo,
      docsRepoToken,
      decision: decision.decision,
      docsPath,
      patchedContent: decision.patchedContent,
      reasoning: decision.reasoning,
      commit,
      affectedSources: sources,
      dryRun,
    });

    log({
      level: "info",
      message: dryRun ? "Dry run planned PR" : "Opened or updated PR",
      docs_file: docsPath,
      decision: decision.decision,
      branch: prResult.branch,
      target_path: prResult.targetPath,
      pull_request: prResult.pullRequest || null,
    });

    results.push({ docsPath, decision: decision.decision, ...prResult });
  }

  log({
    level: "info",
    message: "Docs agent finished",
    commit_sha_short: commit.shortSha,
    summary: summarize(results),
  });
}

function readDocsFile({ docsRepoRoot, docsPath, dryRun }) {
  if (dryRun && !existsSync(docsRepoRoot)) return "";
  const fullPath = path.join(docsRepoRoot, docsPath);
  if (!existsSync(fullPath)) return "";
  return readFileSync(fullPath, "utf8");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function required(value, name) {
  if (!value) {
    log({ level: "error", message: `Missing required env var ${name}` });
    process.exit(1);
  }
  return value;
}

function summarize(results) {
  const summary = { update: 0, human_needed: 0, no_change: 0 };
  for (const result of results) {
    if (result.decision === "UPDATE") summary.update += 1;
    else if (result.decision === "HUMAN_NEEDED") summary.human_needed += 1;
    else if (result.decision === "NO_CHANGE") summary.no_change += 1;
  }
  return summary;
}

function log(fields) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    ...fields,
  }));
}
