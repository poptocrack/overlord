import { isIndexed as isCodegraphIndexed } from "../routes/codegraph.js";
import { buildMarketingSystemPrompt } from "./marketing-prompt.js";
import { isCodeChannel } from "./types.js";
import type { Channel } from "./types.js";

export const DEFAULT_CHAT_PROMPT = "Match the language of the user's message in your response. When you respond in French, always use proper French accents.";

export const CODEGRAPH_NUDGE = `

[CODEGRAPH AVAILABLE]
This project has a CodeGraph index (.codegraph/), a parsed knowledge graph of all symbols, references and call relationships. PREFER these MCP tools over raw Read/Grep/Glob for code exploration:
- mcp__codegraph__codegraph_search: find symbols (functions, classes, types) by name. Faster and more precise than Grep.
- mcp__codegraph__codegraph_context: build a context bundle for a task. Use this BEFORE diving into Read for any non-trivial change.
- mcp__codegraph__codegraph_callers / codegraph_callees: find who calls a function / what a function calls. Replaces multi-file Grep.
- mcp__codegraph__codegraph_impact: find files affected by changing a symbol.
- mcp__codegraph__codegraph_node: get full info on one symbol (signature, doc, location).
- mcp__codegraph__codegraph_explore: graph traversal from a starting symbol.
- mcp__codegraph__codegraph_files: list files (with optional filtering). Replaces Glob.
- mcp__codegraph__codegraph_status: index health check.

Heuristic: if the task involves "where is X used", "find all Y", "what depends on Z", or "context for editing W", start with CodeGraph. Fall back to Read/Grep only when CodeGraph returns nothing useful.
[/CODEGRAPH AVAILABLE]`;

export const HEADLESS_NUDGE = `

[OVERLORD RUNTIME]
You are running headlessly inside Overlord (claude --print), NOT in an interactive terminal. There is NO permission dialog, and the user cannot "click Allow" anywhere. Never tell the user a permission prompt will appear or ask them to approve a tool in their terminal — that does not exist here.

Your tools are gated by a fixed allowlist. If a tool call fails or is denied because it is not allowed (e.g. an MCP tool that is present but not permitted), do NOT invent a terminal approval dialog. Instead, call the tool mcp__overlord__overlord_request_tool with the exact tool name (for an MCP server, request the whole server, e.g. mcp__claude_ai_Gmail, which covers all its tools) and a short reason. This shows the user an Approve/Deny banner directly in the chat; approving adds the tool to the allowlist automatically. After requesting, tell the user a request is waiting for their approval in the chat, and stop attempting that tool until they approve. Only mention the Settings tab as a manual fallback if the request tool itself is unavailable.
[/OVERLORD RUNTIME]`;

export interface EffectivePromptParts {
  base: string;
  nudges: { name: string; content: string; reason: string }[];
  full: string;
}

export function buildEffectiveSystemPrompt(
  project: any,
  channel: Channel,
  projectPath: string
): EffectivePromptParts {
  const base = channel === "marketing"
    ? buildMarketingSystemPrompt(project)
    : (project?.systemPrompt || DEFAULT_CHAT_PROMPT);

  const nudges: EffectivePromptParts["nudges"] = [];

  nudges.push({
    name: "Headless runtime",
    content: HEADLESS_NUDGE,
    reason: "Overlord runs the agent headless — no interactive permission prompts",
  });

  if (isCodeChannel(channel) && isCodegraphIndexed(projectPath)) {
    nudges.push({
      name: "Codegraph",
      content: CODEGRAPH_NUDGE,
      reason: ".codegraph/ found in project, auto-injected",
    });
  }

  const full = base + nudges.map((n) => n.content).join("");
  return { base, nudges, full };
}
