import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { renderLine, type MeetingSummary, type NoteLine } from "./notes";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const USER_NAME = process.env.HUD_USER_NAME ?? "the wearer";

const SummarySchema = z.object({
  title: z.string().describe("3 to 8 words naming what the conversation was about. No date."),
  summary: z.string().describe("3 to 6 sentences: who talked, what was discussed, what came out of it."),
  decisions: z.array(z.string()).describe("Decisions or agreements reached. Empty if none."),
  action_items: z
    .array(z.object({ owner: z.string(), task: z.string() }))
    .describe('Follow-ups. Owner is a name, or "Me" for the wearer. Empty if none.'),
  people: z.array(z.string()).describe("Names of people who took part or were discussed. Empty if none."),
  topics: z.array(z.string()).describe("2 to 5 short topic tags in lowercase."),
});

const client = new Anthropic();

export async function summarize(lines: NoteLine[]): Promise<MeetingSummary | null> {
  const message = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // On a refusal, the API retries the request on a fallback model it picks.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: `You write meeting notes for ${USER_NAME} from a conversation transcribed through their smart glasses. "Me" is ${USER_NAME}; "Them" is anyone else; "Speaker" is unknown. The transcript comes from speech-to-text and has errors: fix obvious mishearings silently, but never add facts that are not in it. Write plain English and do not use em dashes.`,
    messages: [{ role: "user", content: `<transcript>\n${lines.map(renderLine).join("\n")}\n</transcript>` }],
    output_config: { format: betaZodOutputFormat(SummarySchema) },
  });
  if (message.stop_reason === "refusal") return null;
  return message.parsed_output ?? null;
}
