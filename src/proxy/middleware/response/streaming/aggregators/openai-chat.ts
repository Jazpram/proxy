import { OpenAIChatCompletionStreamEvent } from "../index";

export type OpenAiChatCompletionResponse = {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    message: { role: string; content: string };
    finish_reason: string | null;
    index: number;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

/**
 * Given a list of OpenAI chat completion events, compiles them into a single
 * finalized OpenAI chat completion response so that non-streaming middleware
 * can operate on it as if it were a blocking response.
 */
export function mergeEventsForOpenAIChat(
  events: OpenAIChatCompletionStreamEvent[]
): OpenAiChatCompletionResponse {
  let merged: OpenAiChatCompletionResponse = {
    id: "",
    object: "",
    created: 0,
    model: "",
    choices: [],
  };
  merged = events.reduce((acc, event, i) => {
    // The first event will only contain role assignment and response metadata
    if (i === 0) {
      acc.id = event.id;
      acc.object = event.object;
      acc.created = event.created;
      acc.model = event.model;
      acc.choices = [
        {
          index: 0,
          message: {
            role: event.choices[0].delta.role ?? "assistant",
            content: "",
          },
          finish_reason: null,
        },
      ];
      return acc;
    }

    acc.choices[0].finish_reason = event.choices[0].finish_reason;
    if (event.choices[0].delta.content) {
      acc.choices[0].message.content += event.choices[0].delta.content;
    }

    // Accumulate usage data from events (OpenAI may send this in the final event)
    if ((event as any).usage) {
      if (!acc.usage) {
        acc.usage = {};
      }
      const usage = (event as any).usage;
      if (usage.prompt_tokens) acc.usage.prompt_tokens = usage.prompt_tokens;
      if (usage.completion_tokens) acc.usage.completion_tokens = usage.completion_tokens;
      if (usage.total_tokens) acc.usage.total_tokens = usage.total_tokens;
    }

    return acc;
  }, merged);
  return merged;
}
