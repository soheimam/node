#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const MAX_DOC_FILE_CHARS = Number(process.env.DOCS_BRIDGE_MAX_DOC_FILE_CHARS || 24_000);
const MAX_TOTAL_DOC_CHARS = Number(process.env.DOCS_BRIDGE_MAX_TOTAL_DOC_CHARS || 120_000);
const MAX_CHANGED_FILES = Number(process.env.DOCS_BRIDGE_MAX_CHANGED_FILES || 8);
const DEFAULT_MODEL = "claude-sonnet-4-6";
const LLM_GATEWAY_BASE_URL = process.env.LLM_GATEWAY_BASE_URL || "https://llm-gateway.cbhq.net";
const LLM_GATEWAY_REPO_NAME = process.env.LLM_GATEWAY_REPO_NAME || "nodes-docs";

const args = parseArgs(process.argv.slice(2));
const docsRoot = path.resolve(requiredArg(args, "docs-root"));
const contextPath = path.resolve(requiredArg(args, "context"));
const metadataPath = path.resolve(requiredArg(args, "metadata"));
const promptPath = path.resolve(requiredArg(args, "prompt"));
const summaryOutPath = path.resolve(args["summary-out"] || "docs-update-summary.md");
const prBodyOutPath = path.resolve(args["pr-body-out"] || "docs-pr-body.md");

const apiKey = process.env.LLM_API_KEY;
if (!apiKey) {
  logErrorAndExit({
    message: "Missing LLM Gateway API key",
    requiredEnvVar: "LLM_API_KEY",
  });
}

const context = readFileSync(contextPath, "utf8");
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const prompt = readFileSync(promptPath, "utf8");
const candidates = discoverCandidateDocs(docsRoot, metadata);

const response = await requestDocsUpdate({
  apiKey,
  model: process.env.LLM_MODEL || process.env.DOCS_LLM_MODEL || DEFAULT_MODEL,
  prompt,
  context,
  metadata,
  candidates,
});

validateResponse(response);
applyChanges(response.changes, docsRoot);
writeFileSync(summaryOutPath, `${response.summary.trim()}\n`);
writeFileSync(prBodyOutPath, renderPrBody({ metadata, response, candidates }));

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

function requiredArg(parsedArgs, name) {
  if (!parsedArgs[name]) throw new Error(`Missing required argument --${name}`);
  return parsedArgs[name];
}

function discoverCandidateDocs(root, sourceMetadata) {
  const explicitTargets = parseExplicitTargets(root);
  if (explicitTargets.length > 0) return explicitTargets;

  const docsFiles = walk(root).filter(isDocsFile);
  const sourceTerms = buildTerms(sourceMetadata);

  const scored = docsFiles
    .map((filePath) => {
      const relativePath = toPosix(path.relative(root, filePath));
      const content = readFileSync(filePath, "utf8");
      const searchable = `${relativePath}\n${content}`.toLowerCase();
      const score = sourceTerms.reduce(
        (total, term) => total + countOccurrences(searchable, term.toLowerCase()),
        0,
      );
      return {
        path: relativePath,
        content: trimForPrompt(content, MAX_DOC_FILE_CHARS),
        score,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));

  const selected = [];
  let totalChars = 0;
  for (const candidate of scored) {
    if (selected.length >= 12) break;
    if (totalChars + candidate.content.length > MAX_TOTAL_DOC_CHARS) break;
    selected.push(candidate);
    totalChars += candidate.content.length;
  }

  if (selected.length > 0) return selected;

  const fallback = ["README.md", "docs/index.md", "docs/index.mdx", "content/index.md", "content/index.mdx"]
    .map((relativePath) => path.join(root, relativePath))
    .find((filePath) => existsSync(filePath));

  return fallback
    ? [
        {
          path: toPosix(path.relative(root, fallback)),
          content: trimForPrompt(readFileSync(fallback, "utf8"), MAX_DOC_FILE_CHARS),
          score: 1,
        },
      ]
    : [];
}

function parseExplicitTargets(root) {
  const envTargets = splitCsv(process.env.DOCS_TARGET_PATHS || "");
  if (envTargets.length > 0) return readTargets(root, envTargets);

  const mapPath = process.env.DOCS_MAP_PATH;
  if (!mapPath) return [];

  const resolvedMapPath = path.isAbsolute(mapPath) ? mapPath : path.resolve(mapPath);
  if (!existsSync(resolvedMapPath)) return [];

  const docsMap = JSON.parse(readFileSync(resolvedMapPath, "utf8"));
  const changedFiles = new Set(metadataArray("relevantFiles"));
  const targets = new Set();

  for (const [pattern, mappedPaths] of Object.entries(docsMap)) {
    if ([...changedFiles].some((filePath) => matchesSimpleGlob(filePath, pattern))) {
      for (const mappedPath of mappedPaths) targets.add(mappedPath);
    }
  }

  return readTargets(root, [...targets]);
}

function metadataArray(key) {
  return Array.isArray(metadata[key]) ? metadata[key] : [];
}

function readTargets(root, targets) {
  return targets
    .map((target) => target.trim())
    .filter(Boolean)
    .filter((target) => isSafeRelativePath(target))
    .filter((target) => existsSync(path.join(root, target)))
    .map((target) => ({
      path: toPosix(target),
      content: trimForPrompt(readFileSync(path.join(root, target), "utf8"), MAX_DOC_FILE_CHARS),
      score: 100,
    }));
}

function walk(root) {
  const ignoredDirectories = new Set([
    ".git",
    ".next",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".turbo",
  ]);
  const results = [];
  const entries = readdirSync(root);

  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (!ignoredDirectories.has(entry)) results.push(...walk(fullPath));
    } else if (stats.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

function isDocsFile(filePath) {
  return [".md", ".mdx", ".mdoc"].includes(path.extname(filePath));
}

function buildTerms(sourceMetadata) {
  const terms = new Set(["base node", "node", "docker", "configuration"]);
  for (const filePath of sourceMetadata.relevantFiles || []) {
    if (filePath.startsWith("geth/")) terms.add("geth");
    if (filePath.startsWith("nethermind/")) terms.add("nethermind");
    if (filePath === "versions.env") terms.add("version");
    if (filePath.startsWith(".env")) terms.add("environment");
    if (filePath === "docker-compose.yml") terms.add("docker compose");
  }
  return [...terms];
}

function countOccurrences(value, needle) {
  if (!needle) return 0;
  let count = 0;
  let position = 0;
  while ((position = value.indexOf(needle, position)) !== -1) {
    count += 1;
    position += needle.length;
  }
  return count;
}

function trimForPrompt(content, maxChars) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[truncated ${content.length - maxChars} characters]`;
}

async function requestDocsUpdate({ apiKey: key, model, prompt: systemPrompt, context: sourceContext, metadata: sourceMetadata, candidates: docsCandidates }) {
  const candidateBlock =
    docsCandidates.length > 0
      ? docsCandidates.map(renderCandidate).join("\n\n")
      : "No existing docs candidates were found. Create a sensible Markdown or MDX docs file only if the source change requires one.";

  const userContent = `Source metadata:
\`\`\`json
${JSON.stringify(sourceMetadata, null, 2)}
\`\`\`

Source context:
${sourceContext}

Candidate documentation files:
${candidateBlock}`;

  const result = await fetch(`${LLM_GATEWAY_BASE_URL.replace(/\/$/u, "")}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "x-lgw-repo-name": LLM_GATEWAY_REPO_NAME,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: Number(process.env.DOCS_BRIDGE_MAX_TOKENS || 16_000),
      temperature: 0.2,
      system: systemPrompt,
      messages: [
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!result.ok) {
    const body = await result.text();
    throw new Error(`LLM Gateway request failed with ${result.status}: ${body}`);
  }

  const payload = await result.json();
  const content = payload.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!content) throw new Error("LLM Gateway response did not include text content.");
  return JSON.parse(extractJson(content));
}

function logErrorAndExit(details) {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      ...details,
    }),
  );
  process.exit(1);
}

function extractJson(content) {
  const fencedMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fencedMatch) return fencedMatch[1];

  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return content.slice(firstBrace, lastBrace + 1);
  }

  return content;
}

function renderCandidate(candidate) {
  return `BEGIN FILE ${candidate.path}
\`\`\`
${candidate.content}
\`\`\`
END FILE ${candidate.path}`;
}

function validateResponse(response) {
  if (!response || typeof response !== "object") {
    throw new Error("LLM response must be a JSON object.");
  }
  if (typeof response.summary !== "string" || !response.summary.trim()) {
    throw new Error("LLM response must include a non-empty summary.");
  }
  if (!Array.isArray(response.changes)) {
    throw new Error("LLM response must include a changes array.");
  }
  if (response.changes.length > MAX_CHANGED_FILES) {
    throw new Error(`LLM response changed ${response.changes.length} files; maximum is ${MAX_CHANGED_FILES}.`);
  }

  for (const change of response.changes) {
    if (!change || typeof change.path !== "string" || typeof change.content !== "string") {
      throw new Error("Each change must include path and content strings.");
    }
    if (!isSafeRelativePath(change.path)) {
      throw new Error(`Unsafe docs path returned by LLM: ${change.path}`);
    }
    if (isForbiddenGeneratedPath(change.path)) {
      throw new Error(`Refusing to write generated docs change to protected path: ${change.path}`);
    }
    if (containsSecretLikeContent(change.content)) {
      throw new Error(`Refusing to write secret-like generated content to ${change.path}`);
    }
  }
}

function applyChanges(changes, root) {
  for (const change of changes) {
    const destination = path.join(root, change.path);
    const resolvedDestination = path.resolve(destination);
    if (!resolvedDestination.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Resolved path escapes docs root: ${change.path}`);
    }
    mkdirSync(path.dirname(resolvedDestination), { recursive: true });
    writeFileSync(resolvedDestination, normalizeFileContent(change.content));
  }
}

function isSafeRelativePath(relativePath) {
  if (path.isAbsolute(relativePath)) return false;
  const normalized = path.normalize(relativePath);
  return !normalized.startsWith("..") && !normalized.includes(`${path.sep}..${path.sep}`);
}

function isForbiddenGeneratedPath(relativePath) {
  const normalized = toPosix(path.normalize(relativePath));
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.startsWith(".github/workflows/") ||
    normalized.endsWith(".pem") ||
    normalized.endsWith(".key") ||
    normalized.includes("secret")
  );
}

function containsSecretLikeContent(content) {
  return /(api[_-]?key|private[_-]?key|password|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{16,}/i.test(
    content,
  );
}

function normalizeFileContent(content) {
  return `${content.replace(/\s+$/u, "")}\n`;
}

function renderPrBody({ metadata: sourceMetadata, response, candidates: docsCandidates }) {
  const source = sourceMetadata.source || {};
  const changedFiles = sourceMetadata.relevantFiles || [];
  const candidatePaths = docsCandidates.map((candidate) => candidate.path);
  const changedDocs = response.changes.map((change) => change.path);

  return `## Summary
${response.summary.trim()}

## Source Change
- Source commit: ${source.head || "unknown"}
- Compare: ${source.compareUrl || "unavailable"}
- Commit title: ${source.commitTitle || "unknown"}

## Source Files Reviewed
${changedFiles.map((file) => `- \`${file}\``).join("\n") || "- None"}

## Docs Files Considered
${candidatePaths.map((file) => `- \`${file}\``).join("\n") || "- None discovered"}

## Docs Files Updated
${changedDocs.map((file) => `- \`${file}\``).join("\n") || "- No documentation files changed"}

Generated by the node docs bridge workflow. Please review for technical accuracy before merging.
`;
}

function splitCsv(value) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function matchesSimpleGlob(filePath, pattern) {
  const escaped = pattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}
