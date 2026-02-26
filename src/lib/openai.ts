import OpenAI from "openai";
import { AgentSpec } from "./agents.js";

const SYSTEM_PROMPT = `You are an expert CLI agent designer.\n\nReturn ONLY valid JSON.\nNo markdown, no commentary.\n\nDesign an agent that runs in the terminal and uses the OpenAI Responses API.\nThe agent should be fast, deterministic, and safe.\nProvide a concise system_prompt that defines the agent behavior.\nAvoid any network calls besides OpenAI.\n\nIf diagrams are helpful, instruct the agent to include Mermaid in a fenced code block (\\\`\\\`\\\`mermaid ... \\\`\\\`\\\`).\nIf code is helpful, instruct the agent to include code in fenced blocks (\\\`\\\`\\\`language ... \\\`\\\`\\\`).\n\nDependencies:\n- Only include npm packages.\n- If unsure, omit dependencies entirely.\n\nJSON format:\n{\n  \"name\": string,\n  \"description\": string,\n  \"system_prompt\": string,\n  \"model\": string (optional),\n  \"dependencies\": { \"package\": \"version\" } (optional)\n}\n`;

export async function buildAgentSpec(
  description: string,
  nameHint: string | undefined,
  model: string,
  options?: {
    onStartStream?: () => void;
    onFirstToken?: () => void;
    onToken?: (delta: string) => void;
  }
): Promise<AgentSpec> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const client = new OpenAI({ apiKey });
  const userPrompt = [
    nameHint ? `Agent name hint: ${nameHint}` : "",
    `Agent request: ${description}`
  ]
    .filter(Boolean)
    .join("\n");

  const stream = await client.responses.create({
    model,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    text: {
      format: {
        type: "json_object"
      }
    },
    stream: true
  });

  let raw = "";
  if (options?.onStartStream) {
    options.onStartStream();
  }
  let sawToken = false;
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      const delta = event.delta || "";
      if (!sawToken) {
        sawToken = true;
        if (options?.onFirstToken) options.onFirstToken();
      }
      raw += delta;
      if (options?.onToken) {
        options.onToken(delta);
      } else {
        process.stdout.write(delta);
      }
    }
  }
  process.stdout.write("\n");
  if (!raw.trim()) {
    throw new Error("Model returned empty output.");
  }

  let spec: AgentSpec;
  try {
    spec = JSON.parse(raw) as AgentSpec;
  } catch (err) {
    throw new Error(`Failed to parse model JSON: ${String(err)}`);
  }

  if (!spec.name || !spec.description || !spec.system_prompt) {
    throw new Error("Model JSON missing required fields.");
  }

  return spec;
}
