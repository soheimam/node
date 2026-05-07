const GITHUB_API = "https://api.github.com";
const MAX_DIFF_BYTES = Number(process.env.DOCS_AGENT_MAX_DIFF_BYTES || 200 * 1024);

export async function fetchDiff({ sourceRepo, commitSha, githubToken }) {
  if (!sourceRepo || !commitSha) {
    throw new Error("fetchDiff requires sourceRepo and commitSha");
  }

  const url = `${GITHUB_API}/repos/${sourceRepo}/commits/${commitSha}`;
  const baseHeaders = {
    "User-Agent": "node-docs-agent",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) {
    baseHeaders.Authorization = `Bearer ${githubToken}`;
  }

  const [metadataResponse, diffResponse] = await Promise.all([
    fetch(url, {
      headers: { ...baseHeaders, Accept: "application/vnd.github+json" },
    }),
    fetch(url, {
      headers: { ...baseHeaders, Accept: "application/vnd.github.diff" },
    }),
  ]);

  if (!metadataResponse.ok) {
    throw new Error(
      `GitHub commit metadata request failed: ${metadataResponse.status} ${metadataResponse.statusText}`,
    );
  }
  if (!diffResponse.ok) {
    throw new Error(
      `GitHub commit diff request failed: ${diffResponse.status} ${diffResponse.statusText}`,
    );
  }

  const metadata = await metadataResponse.json();
  const rawDiff = await diffResponse.text();
  const diff = truncateDiff(rawDiff, MAX_DIFF_BYTES);

  const changedFiles = Array.isArray(metadata.files)
    ? metadata.files
        .map((file) => file.filename)
        .filter((name) => typeof name === "string" && name.length > 0)
    : [];

  return {
    diff,
    diffWasTruncated: diff !== rawDiff,
    changedFiles,
    commitSha: metadata.sha || commitSha,
    shortSha: (metadata.sha || commitSha).slice(0, 12),
    commitTitle: (metadata.commit?.message || "").split("\n")[0] || "",
    commitUrl: metadata.html_url || `https://github.com/${sourceRepo}/commit/${commitSha}`,
    commitAuthor: metadata.commit?.author?.name || metadata.author?.login || "",
    sourceRepo,
  };
}

function truncateDiff(value, maxBytes) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  const truncatedBytes = buffer.length - maxBytes;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n\n[truncated ${truncatedBytes} bytes]`;
}
