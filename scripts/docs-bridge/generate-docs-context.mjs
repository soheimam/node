#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAX_DIFF_CHARS = Number(process.env.DOCS_CONTEXT_MAX_DIFF_CHARS || 120_000);

const args = parseArgs(process.argv.slice(2));
const sourceRoot = path.resolve(args["source-root"] || process.cwd());
const head = args.head || process.env.GITHUB_SHA || "HEAD";
const base = args.base || getDefaultBase(head);
const outPath = path.resolve(args.out || "docs-context.md");
const metadataOutPath = path.resolve(args["metadata-out"] || "docs-metadata.json");

const changedFiles = gitLines(["diff", "--name-only", `${base}..${head}`]);
const relevantFiles = changedFiles.filter(isRelevantPath);
const hasRelevantChanges = relevantFiles.length > 0;
const shortHead = git(["rev-parse", "--short=12", head]);
const commitTitle = git(["log", "-1", "--format=%s", head]);
const commitAuthor = git(["log", "-1", "--format=%an <%ae>", head]);
const remoteUrl = git(["config", "--get", "remote.origin.url"]);
const compareUrl = buildCompareUrl(remoteUrl, base, head);
const diff = hasRelevantChanges
  ? truncate(
      git([
        "diff",
        "--find-renames",
        "--find-copies",
        "--unified=80",
        `${base}..${head}`,
        "--",
        ...relevantFiles,
      ]),
      MAX_DIFF_CHARS,
    )
  : "";

const inventory = {
  versions: parseVersions(readSourceFile("versions.env")),
  env: {
    mainnet: parseEnv(readSourceFile(".env.mainnet")),
    sepolia: parseEnv(readSourceFile(".env.sepolia")),
  },
  dockerCompose: summarizeDockerCompose(readSourceFile("docker-compose.yml")),
  entrypoints: {
    geth: summarizeEntrypoint(readSourceFile("geth/geth-entrypoint")),
    nethermind: summarizeEntrypoint(readSourceFile("nethermind/nethermind-entrypoint")),
  },
};

const classifications = classifyChanges(relevantFiles, diff);
const metadata = {
  hasRelevantChanges,
  source: {
    repository: normalizeRepoName(remoteUrl),
    remoteUrl,
    base,
    head,
    shortHead,
    commitTitle,
    commitAuthor,
    compareUrl,
  },
  changedFiles,
  relevantFiles,
  classifications,
  diffWasTruncated: diff.includes("[truncated"),
};

writeFileSync(metadataOutPath, `${JSON.stringify(metadata, null, 2)}\n`);
writeFileSync(outPath, renderContext({ metadata, inventory, diff }));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function getDefaultBase(defaultHead) {
  const before = process.env.GITHUB_EVENT_BEFORE || process.env.GITHUB_BASE_SHA;
  if (before && !/^0+$/.test(before)) return before;
  try {
    return git(["rev-parse", `${defaultHead}^`]);
  } catch {
    return git(["rev-list", "--max-parents=0", defaultHead]).split("\n")[0];
  }
}

function git(argsForGit) {
  return execFileSync("git", argsForGit, {
    cwd: sourceRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function gitLines(argsForGit) {
  const output = git(argsForGit);
  return output ? output.split("\n").filter(Boolean) : [];
}

function readSourceFile(relativePath) {
  const fullPath = path.join(sourceRoot, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

function isRelevantPath(filePath) {
  return (
    filePath.startsWith("geth/") ||
    filePath.startsWith("nethermind/") ||
    filePath === "versions.env" ||
    filePath === ".env" ||
    filePath === ".env.mainnet" ||
    filePath === ".env.sepolia" ||
    filePath === "docker-compose.yml" ||
    filePath === "README.md"
  );
}

function parseVersions(contents) {
  return Object.fromEntries(
    contents
      .split("\n")
      .map((line) => line.match(/^export\s+([A-Z0-9_]+)=(.*)$/))
      .filter(Boolean)
      .map((match) => [match[1], redactIfSensitive(match[1], match[2])]),
  );
}

function parseEnv(contents) {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const [key, ...valueParts] = line.split("=");
      return { key, value: redactIfSensitive(key, valueParts.join("=")) };
    });
}

function summarizeDockerCompose(contents) {
  const services = [...contents.matchAll(/^  ([a-zA-Z0-9_-]+):$/gm)].map((match) => match[1]);
  const ports = [...contents.matchAll(/^\s+-\s+"([^"]+)"\s*(?:#\s*(.*))?$/gm)].map((match) => ({
    mapping: match[1],
    note: match[2] || "",
  }));
  const dockerfiles = [...contents.matchAll(/dockerfile:\s*(.+)$/gm)].map((match) => match[1].trim());

  return { services, ports, dockerfiles };
}

function summarizeEntrypoint(contents) {
  const envDefaults = [
    ...contents.matchAll(/^([A-Z0-9_]+)=\$\{([A-Z0-9_]+):-([^}]+)\}/gm),
  ].map((match) => ({
    key: match[1],
    default: redactIfSensitive(match[1], match[3]),
  }));
  const requiredEnv = [
    ...contents.matchAll(/Expected?\s+([A-Z0-9_]+)\s+to be set|expected\s+([A-Z0-9_]+)\s+to be set/gim),
  ].map((match) => match[1] || match[2]);
  const commandFlags = [
    ...contents.matchAll(/(?:^|\s)(--[A-Za-z0-9_.-]+)(?:=|\s|$)/gm),
  ].map((match) => match[1]);

  return {
    envDefaults,
    requiredEnv: [...new Set(requiredEnv)],
    commandFlags: [...new Set(commandFlags)].sort(),
  };
}

function redactIfSensitive(key, value) {
  if (/(SECRET|TOKEN|PASSWORD|PRIVATE|AUTH_RAW|API_KEY|KEY)/i.test(key)) {
    return "[redacted]";
  }
  return value;
}

function classifyChanges(files, unifiedDiff) {
  const classes = new Set();
  if (files.some((file) => file === "versions.env")) classes.add("version bump");
  if (files.some((file) => file.startsWith("geth/"))) classes.add("geth runtime or build change");
  if (files.some((file) => file.startsWith("nethermind/"))) classes.add("nethermind runtime or build change");
  if (files.some((file) => file.startsWith(".env") || file === "docker-compose.yml")) {
    classes.add("configuration or port change");
  }
  if (/^\+.*--[A-Za-z0-9_.-]+/m.test(unifiedDiff) || /^-.*--[A-Za-z0-9_.-]+/m.test(unifiedDiff)) {
    classes.add("runtime flag change");
  }
  if (/^\+.*(OPTIONAL|FEATURE|FLASHBLOCKS|PRUNING)/im.test(unifiedDiff)) {
    classes.add("optional feature change");
  }
  if (classes.size === 0 && files.length > 0) classes.add("docs-relevant source change");
  if (files.length === 0) classes.add("docs-only/no-op");
  return [...classes];
}

function truncate(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} characters]`;
}

function buildCompareUrl(remote, baseSha, headSha) {
  const repo = normalizeRepoName(remote);
  return repo ? `https://github.com/${repo}/compare/${baseSha}...${headSha}` : "";
}

function normalizeRepoName(remote) {
  const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
  return match ? match[1] : "";
}

function renderContext({ metadata: contextMetadata, inventory: contextInventory, diff: unifiedDiff }) {
  return `# Node Docs Update Context

## Source Change
- Repository: ${contextMetadata.source.repository || contextMetadata.source.remoteUrl}
- Base: ${contextMetadata.source.base}
- Head: ${contextMetadata.source.head}
- Short head: ${contextMetadata.source.shortHead}
- Commit title: ${contextMetadata.source.commitTitle}
- Commit author: ${contextMetadata.source.commitAuthor}
- Compare URL: ${contextMetadata.source.compareUrl || "Unavailable"}

## Changed Files
${contextMetadata.changedFiles.map((file) => `- ${file}`).join("\n") || "- None"}

## Docs-Relevant Files
${contextMetadata.relevantFiles.map((file) => `- ${file}`).join("\n") || "- None"}

## Change Classification
${contextMetadata.classifications.map((classification) => `- ${classification}`).join("\n")}

## Current Version Pins
\`\`\`json
${JSON.stringify(contextInventory.versions, null, 2)}
\`\`\`

## Current Runtime Configuration Inventory
\`\`\`json
${JSON.stringify(contextInventory, null, 2)}
\`\`\`

## Relevant Unified Diff
\`\`\`diff
${unifiedDiff || "No docs-relevant diff was found."}
\`\`\`
`;
}
