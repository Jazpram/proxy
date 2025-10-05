import { StreamingCompletionTransformer } from "../index";
import { parseEvent } from "../parse-sse";
import { logger } from "../../../../../logger";
import { asAnthropicChatDelta } from "./anthropic-chat-to-anthropic-v2";

const log = logger.child({
  module: "sse-transformer",
  transformer: "anthropic-chat-to-openai",
});

/**
 * Transforms an incoming Anthropic Chat SSE to an equivalent OpenAI
 * chat.completion.chunks SSE.
 */
export const anthropicChatToOpenAI: StreamingCompletionTransformer = (
  params
) => {
  const { data } = params;

  const rawEvent = parseEvent(data);
  if (!rawEvent.data || !rawEvent.type) {
    return { position: -1 };
  }

  // Try to extract usage data from message_start and message_delta events
  // Also check for AWS Bedrock invocationMetrics
  let usageData: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | undefined;
  try {
    const parsed = JSON.parse(rawEvent.data);
    if (parsed.type === "message_start" && parsed.message?.usage) {
      usageData = {
        input_tokens: parsed.message.usage.input_tokens,
        output_tokens: parsed.message.usage.output_tokens,
        cache_creation_input_tokens: parsed.message.usage.cache_creation_input_tokens,
        cache_read_input_tokens: parsed.message.usage.cache_read_input_tokens,
      };
    } else if (parsed.type === "message_delta" && parsed.delta?.usage) {
      usageData = {
        output_tokens: parsed.delta.usage.output_tokens,
        cache_creation_input_tokens: parsed.delta.usage.cache_creation_input_tokens,
        cache_read_input_tokens: parsed.delta.usage.cache_read_input_tokens,
      };
    }
    // AWS Bedrock includes usage in amazon-bedrock-invocationMetrics
    // AWS uses PascalCase field names (CacheReadInputTokens, CacheWriteInputTokens)
    else if (parsed["amazon-bedrock-invocationMetrics"]) {
      const metrics = parsed["amazon-bedrock-invocationMetrics"];
      usageData = {
        input_tokens: metrics.inputTokenCount,
        output_tokens: metrics.outputTokenCount,
        // Map AWS PascalCase to Anthropic snake_case
        cache_read_input_tokens: metrics.cacheReadInputTokenCount,
        cache_creation_input_tokens: metrics.cacheWriteInputTokenCount,
      };
      log.debug(
        { metrics, usageData },
        "Extracted usage from AWS invocationMetrics"
      );
    }
  } catch (e) {
    // Ignore parsing errors
  }

  const deltaEvent = asAnthropicChatDelta(rawEvent);
  if (!deltaEvent) {
    // If we have usage data but no delta, still emit an event with usage
    if (usageData) {
      const usageEvent = {
        id: params.fallbackId,
        object: "chat.completion.chunk" as const,
        created: Date.now(),
        model: params.fallbackModel,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: null,
          },
        ],
        usage: usageData,
      };
      return { position: -1, event: usageEvent };
    }
    return { position: -1 };
  }

  const newEvent = {
    id: params.fallbackId,
    object: "chat.completion.chunk" as const,
    created: Date.now(),
    model: params.fallbackModel,
    choices: [
      {
        index: 0,
        delta: { content: deltaEvent.delta.text },
        finish_reason: null,
      },
    ],
    ...(usageData && { usage: usageData }),
  };

  return { position: -1, event: newEvent };
};
