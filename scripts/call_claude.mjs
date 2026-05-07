const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = Number(process.env.DOCS_AGENT_MAX_TOKENS || 16_000);
const MAX_DOC_BYTES = Number(process.env.DOCS_AGENT_MAX_DOC_BYTES || 80 * 1024);
const VALID_DECISIONS = new Set(["UPDATE", "NO_CHANGE", "HUMAN_NEEDED"]);

const SYSTEM_PROMPT = `You decide whether a Mintlify documentation file needs to change in response to a source code commit.

Rules:
- Only propose UPDATE when the source change directly affects user-facing behavior or operator-visible configuration documented in the file.
- Preserve existing frontmatter, headings, imports, MDX components, and tone of the docs file.
- Never invent behavior beyond what the source diff supports. When uncertain, return HUMAN_NEEDED with reasoning.
- Never include secrets, API keys, tokens, credentials, placeholders, TODOs, or emojis in patched_content.
- Return strict JSON only. Do not wrap in Markdown fences.

Response schema:
{
  "decision": "UPDATE" | "NO_CHANGE" | "HUMAN_NEEDED",
  "reasoning": "1 to 3 sentences",
  "patched_content": "Full new file content. Required when decision is UPDATE. Omit otherwise."
}`;

export async function callClaude({
  apiKey,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  diff,
  commit,
  docsPath,
  docsContent,
  affectedSources,
}) {
  if (!apiKey) throw new Error("callClaude requires ANTHROPIC_API_KEY");

  const userContent = renderUserMessage({ diff, commit, docsPath, docsContent, affectedSources });

  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic request failed with ${response.status}: ${body}`);
  }

  const payload = await response.json();
  const text = (payload.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic response did not include text content");

  const parsed = JSON.parse(extractJson(text));
  return validateDecision(parsed, docsPath);
}

function renderUserMessage({ diff, commit, docsPath, docsContent, affectedSources }) {
  const truncatedDocs = truncateUtf8(docsContent || "", MAX_DOC_BYTES);
  return [
    `Source repository: ${commit.sourceRepo}`,
    `Commit: ${commit.shortSha} (${commit.commitUrl})`,
    `Commit title: ${commit.commitTitle || "unknown"}`,
    "",
    "Source paths matched against this docs file:",
    affectedSources.map((source) => `- ${source}`).join("\n") || "- (none)",
    "",
    `Docs file under review: ${docsPath}`,
    "",
    "Current docs file content:",
    "BEGIN FILE",
    truncatedDocs,
    "END FILE",
    "",
    "Source unified diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

function validateDecision(parsed, docsPath) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Claude response for ${docsPath} was not a JSON object`);
  }
  if (!VALID_DECISIONS.has(parsed.decision)) {
    throw new Error(`Claude response for ${docsPath} had invalid decision: ${parsed.decision}`);
  }
  if (typeof parsed.reasoning !== "string" || !parsed.reasoning.trim()) {
    throw new Error(`Claude response for ${docsPath} was missing reasoning`);
  }

  if (parsed.decision === "UPDATE") {
    if (typeof parsed.patched_content !== "string" || !parsed.patched_content.trim()) {
      throw new Error(`Claude UPDATE for ${docsPath} was missing patched_content`);
    }
    if (containsSecretLikeContent(parsed.patched_content)) {
      throw new Error(`Claude UPDATE for ${docsPath} contained secret-like content; rejecting`);
    }
  } else if (parsed.patched_content && parsed.decision !== "UPDATE") {
    delete parsed.patched_content;
  }

  return {
    decision: parsed.decision,
    reasoning: parsed.reasoning.trim(),
    patchedContent: parsed.patched_content ? normalizeContent(parsed.patched_content) : null,
  };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) return text.slice(firstBrace, lastBrace + 1);
  return text;
}

function containsSecretLikeContent(content) {
  return /(api[_-]?key|private[_-]?key|password|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{16,}/i.test(content);
}

function normalizeContent(content) {
  return `${content.replace(/\s+$/u, "")}\n`;
}

function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n\n[truncated ${buffer.length - maxBytes} bytes]`;
}
