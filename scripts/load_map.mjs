import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function loadDocsMap(mapPath) {
  const yaml = loadYaml();
  const raw = readFileSync(mapPath, "utf8");
  const parsed = yaml.load(raw);
  if (parsed === null || parsed === undefined) return {};

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`docs-map at ${mapPath} must be a YAML mapping of glob to docs paths`);
  }

  const normalized = {};
  for (const [glob, value] of Object.entries(parsed)) {
    if (!glob || typeof glob !== "string") continue;
    const docsPaths = Array.isArray(value)
      ? value.filter((item) => typeof item === "string" && item.length > 0)
      : typeof value === "string" && value.length > 0
        ? [value]
        : [];
    if (docsPaths.length > 0) normalized[glob] = docsPaths;
  }
  return normalized;
}

export function findAffectedDocs({ docsMap, changedFiles }) {
  const matches = new Map();
  for (const filePath of changedFiles) {
    if (typeof filePath !== "string" || filePath.length === 0) continue;
    for (const [glob, docsPaths] of Object.entries(docsMap)) {
      if (!matchesGlob(filePath, glob)) continue;
      for (const docsPath of docsPaths) {
        const list = matches.get(docsPath) || [];
        if (!list.includes(filePath)) list.push(filePath);
        matches.set(docsPath, list);
      }
    }
  }

  return [...matches.entries()]
    .map(([docsPath, sources]) => ({ docsPath, sources }))
    .sort((left, right) => left.docsPath.localeCompare(right.docsPath));
}

export function matchesGlob(filePath, pattern) {
  const regex = globToRegExp(pattern);
  return regex.test(filePath);
}

function globToRegExp(pattern) {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        regex += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else if ("/.+()|^$[]{}\\".includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

function loadYaml() {
  try {
    return require("js-yaml");
  } catch (error) {
    throw new Error(
      "load_map.mjs requires js-yaml. Install it on the runner with `npm install --prefix \"$RUNNER_TEMP/agent-deps\" --no-save js-yaml` and set NODE_PATH accordingly.",
      { cause: error },
    );
  }
}
