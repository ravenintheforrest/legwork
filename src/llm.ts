// One interface for model calls. Nothing else in the fleet imports the SDK, so cost
// metering and the offline path stay in one place.

export interface LLMRequest {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface LLMResponse {
  text: string;
  tokens_in: number;
  tokens_out: number;
}

export interface LLM {
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export function makeLLM(): LLM | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new AnthropicLLM(apiKey);
}

class AnthropicLLM implements LLM {
  constructor(private readonly apiKey: string) {}

  async complete(req: LLMRequest): Promise<LLMResponse> {
    // Lazy import: the SDK is only loaded when a key is actually present.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: this.apiKey });

    const response = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
    });

    // TODO: handle the server-side refusal stop reason for fable-tier calls; that
    // needs an SDK bump before it can be narrowed properly.
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return {
      text,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
    };
  }
}
