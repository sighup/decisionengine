import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { EXTRACTION_INSTRUCTIONS, ExtractionSchema, existingSummary, SOURCE_LABEL, toProposals, type Proposal } from "../core/extraction.js";

/**
 * The service's own extractor, used when the service holds an Anthropic key
 * and a client sends raw material. Clients can instead extract with their own
 * Claude (the Claude Code plugin, or `claude -p`) and send the result; see
 * `src/core/extraction.ts` for the contract both follow. Either way the model
 * only captures: everything is recorded as `proposed`.
 */

export { MAX_CAPTURE_CHARS, type CaptureSource } from "../core/capture.js";
import { MAX_CAPTURE_CHARS, type CaptureSource } from "../core/capture.js";
import type { Decision } from "../core/types.js";

export interface ExtractInput {
  source: CaptureSource;
  text: string;
  /** Existing decisions, so the extractor can skip duplicates and link related ones. */
  existing: Decision[];
}

export type { Proposal } from "../core/extraction.js";

export interface Extractor {
  extract(input: ExtractInput): Promise<Proposal[]>;
}

export class ExtractionUnavailableError extends Error {}

export class ClaudeExtractor implements Extractor {
  private client: Anthropic;

  constructor(
    private opts: { model?: string; effort?: "low" | "medium" | "high" | "xhigh" | "max"; client?: Anthropic } = {},
  ) {
    this.client = opts.client ?? new Anthropic();
  }

  async extract({ source, text, existing }: ExtractInput): Promise<Proposal[]> {
    if (text.length > MAX_CAPTURE_CHARS) throw new RangeError(`material is ${text.length} characters; the limit per request is ${MAX_CAPTURE_CHARS}`);
    const stream = this.client.beta.messages.stream({
      model: this.opts.model ?? "claude-opus-5-5",
      max_tokens: 32_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: this.opts.effort ?? "high", format: betaZodOutputFormat(ExtractionSchema) },
      system: EXTRACTION_INSTRUCTIONS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `Existing decisions:\n${existingSummary(existing)}` },
            { type: "text", text: `The material below is ${SOURCE_LABEL[source]}.\n\n<material>\n${text}\n</material>\n\nExtract the settled decisions.` },
          ],
        },
      ],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") return [];
    if (message.stop_reason === "max_tokens") throw new Error("extraction output was cut off; send smaller chunks");
    if (!message.parsed_output) throw new Error("extraction returned no structured output");
    return toProposals(message.parsed_output, existing);
  }
}

/** The service's extractor, or undefined when no Anthropic credentials are configured. */
export function defaultExtractor(): Extractor | undefined {
  if (process.env.DE_CAPTURE === "off") return undefined;
  // Credentials resolve like any Anthropic SDK client (env vars or an `ant auth login` profile).
  // Without DE_CAPTURE=on we only enable capture when a key is visibly configured.
  if (process.env.DE_CAPTURE !== "on" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return undefined;
  return new ClaudeExtractor({
    model: process.env.DE_CAPTURE_MODEL || undefined,
    effort: (process.env.DE_CAPTURE_EFFORT as any) || undefined,
  });
}
