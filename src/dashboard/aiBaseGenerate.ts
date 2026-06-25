// `.base` generation: builds a system prompt from the built-in `obsidian-bases`
// skill and streams a completion from the configured local LLM. Read-only vault
// tools are made available so the model can inspect existing notes before
// authoring. Unlike the multi-provider upstream, this port targets the single
// local LLM via `localLlmChatStream` and runs its own tool-call loop.

import type { LocalLlmHubPlugin } from "src/plugin";
import { localLlmChatStream } from "src/core/localLlmProvider";
import { getVaultTools } from "src/core/tools";
import { executeToolCall } from "src/core/toolExecutor";
import { loadBuiltinSkill, builtinFolderPath } from "src/core/builtinSkills";
import type { Message, ToolCall, ToolDefinition } from "src/types";

/** Read-only vault tools the model may use to inspect notes while authoring. */
const READONLY_TOOL_NAMES = new Set([
  "read_note",
  "search_notes",
  "list_notes",
  "list_folders",
  "get_active_note",
]);

/** Hard cap on tool-call rounds so a misbehaving model can't loop forever. */
const MAX_TOOL_ROUNDS = 12;

/** Build the system prompt for `.base` generation from the built-in skill. */
export function buildBaseSystemPrompt(): string {
  const skill = loadBuiltinSkill(builtinFolderPath("obsidian-bases"));
  const reference = skill
    ? `${skill.instructions}\n\n${skill.references.join("\n\n")}`
    : "";
  return [
    "You are an expert at authoring Obsidian Bases (`.base`) files.",
    "Produce a single valid `.base` YAML document that satisfies the user's request.",
    "You may use the read-only vault tools (read_note, search_notes, list_notes,",
    "list_folders, get_active_note) to inspect existing notes and their",
    "properties, for example to find which frontmatter property holds an image,",
    "cover, or status. Do not assume property names; verify them against real",
    "notes when relevant.",
    "Your FINAL message must contain ONLY the `.base` YAML, no prose, no",
    "explanation, and no Markdown code fences.",
    "",
    reference,
  ].join("\n");
}

/** Strip a wrapping ```yaml / ``` code fence if the model added one. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:ya?ml)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return (fence ? fence[1] : trimmed).trim();
}

/**
 * Generate `.base` YAML for the given request. `currentYaml` is included for
 * edits so the model revises in place. Returns cleaned YAML (no fences).
 */
export async function generateBaseYaml(
  plugin: LocalLlmHubPlugin,
  request: string,
  currentYaml?: string,
): Promise<string> {
  const systemPrompt = buildBaseSystemPrompt();

  const userPrompt = currentYaml
    ? `Revise the following \`.base\` file according to this request:\n\n${request}\n\nCurrent \`.base\` content:\n\`\`\`yaml\n${currentYaml}\n\`\`\``
    : `Create a \`.base\` file for this request:\n\n${request}`;

  const messages: Message[] = [{ role: "user", content: userPrompt, timestamp: Date.now() }];
  const raw = await streamWithTools(plugin, messages, systemPrompt);
  const yaml = stripCodeFence(raw);
  if (!yaml) throw new Error("The model returned an empty result.");
  return yaml;
}

/**
 * Stream a completion from the local LLM with read-only vault tools, running a
 * manual tool-call loop (execute tools → feed results back → continue) until the
 * model produces a final text answer or the round cap is reached.
 */
async function streamWithTools(
  plugin: LocalLlmHubPlugin,
  messages: Message[],
  systemPrompt: string,
): Promise<string> {
  const tools: ToolDefinition[] = getVaultTools("all").filter((tool) =>
    READONLY_TOOL_NAMES.has(tool.function.name),
  );
  const conversation: Message[] = [...messages];
  const abort = new AbortController();
  let finalText = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let text = "";
    const pending: ToolCall[] = [];

    for await (const chunk of localLlmChatStream(
      plugin.settings.llmConfig,
      conversation,
      systemPrompt,
      abort.signal,
      tools,
    )) {
      if (chunk.type === "text" && chunk.content) text += chunk.content;
      else if (chunk.type === "replace_text") text = chunk.content || "";
      else if (chunk.type === "tool_call" && chunk.toolCall) pending.push(chunk.toolCall);
      else if (chunk.type === "error") throw new Error(chunk.error || "Generation failed");
    }

    if (pending.length === 0) {
      finalText = text;
      break;
    }

    conversation.push({
      role: "assistant",
      content: text,
      timestamp: Date.now(),
      toolCalls: pending,
    });

    for (const tc of pending) {
      const result = await executeToolCall(tc, { app: plugin.app });
      conversation.push({
        role: "tool",
        content: result.result,
        timestamp: Date.now(),
        toolCallId: tc.id,
        toolName: tc.name,
      });
    }
  }

  return finalText;
}
