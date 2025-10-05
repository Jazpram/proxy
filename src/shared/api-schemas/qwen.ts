import { z } from "zod";
import { OPENAI_OUTPUT_MAX } from "./openai";

/**
 * Helper function to check if a model is from Qwen
 */
export function isQwenModel(model: string): boolean {
  return model.startsWith("qwen") || model.includes("qwen");
}

/**
 * Helper function to check if a model supports thinking capability
 */
export function isQwenThinkingModel(model: string): boolean {
  if (model.startsWith("qwen3")) {
    return true;
  }
  
  // QwQ models support thinking
  if (model.startsWith("qwq")) {
    return true;
  }
  
  // Commercial models that support thinking
  return (
    model === "qwen-plus-latest" ||
    model === "qwen-plus-2025-04-28" ||
    model === "qwen-turbo-latest" ||
    model === "qwen-turbo-2025-04-28" ||
    model === "qwen-flash" ||
    model === "qwen-flash-latest" ||
    model === "qwen-flash-2025-07-28"
  );
}

// Basic chat message schema
const QwenChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.union([z.string(), z.null(), z.array(z.any())]).nullable(),
  name: z.string().optional(),
  partial: z.boolean().optional(), // For partial mode support
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
});

const QwenMessagesSchema = z.array(QwenChatMessageSchema);

// Schema for Qwen chat completions
export const QwenV1ChatCompletionsSchema = z.object({
  model: z.string(),
  messages: QwenMessagesSchema,
  temperature: z.number().min(0).max(2).optional().default(1),
  top_p: z.number().min(0).max(1).optional().default(1),
  top_k: z.number().int().min(0).optional(),
  max_tokens: z.coerce
    .number()
    .int()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  max_input_tokens: z.number().int().optional(),
  stream: z.boolean().optional().default(false),
  stream_options: z.object({
    include_usage: z.boolean().optional()
  }).optional(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .default([])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  seed: z.number().int().min(0).max(2147483647).optional(),
  response_format: z
    .object({
      type: z.enum(["text", "json_object"]),
      schema: z.any().optional()
    })
    .optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([
    z.enum(["auto", "none"]),
    z.object({
      type: z.literal("function"),
      function: z.object({
        name: z.string()
      })
    })
  ]).optional(),
  parallel_tool_calls: z.boolean().optional().default(false),
  frequency_penalty: z.number().optional().default(0),
  presence_penalty: z.number().min(-2).max(2).optional().default(0),
  n: z.number().int().min(1).max(4).optional().default(1),
  logprobs: z.boolean().optional().default(false),
  top_logprobs: z.number().int().min(0).max(5).optional().default(0),
  // Qwen-specific parameters
  enable_thinking: z.boolean().optional(),
  thinking_budget: z.number().int().optional(),
  // Qwen-Omni multimodal parameters
  modalities: z.array(z.enum(["text", "audio"])).optional().default(["text"]),
  audio: z.object({
    voice: z.string().optional(),
    format: z.string().optional()
  }).optional(),
  // Translation parameters
  translation_options: z.object({
    source_language: z.string().optional(),
    target_language: z.string().optional()
  }).optional(),
});

// Schema for Qwen embeddings
export const QwenV1EmbeddingsSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(["float", "base64"]).optional()
});

/**
 * Helper function to normalize messages for Qwen API
 * Qwen uses the standard OpenAI message format, so no transformation is needed
 */
export function normalizeMessages(messages: any[]): any[] {
  return messages;
}

/**
 * Helper function to check if a model is a Qwen3 model
 */
export function isQwen3Model(model: string): boolean {
  return model.startsWith("qwen3");
}


/**
 * Helper function to check if a model is a commercial Qwen model
 */
export function isQwenCommercialModel(model: string): boolean {
  const commercialModels = [
    "qwen-max", "qwen-max-latest", "qwen-max-2025-01-25",
    "qwen-plus", "qwen-plus-latest", "qwen-plus-2025-04-28", "qwen-plus-2025-01-25",
    "qwen-turbo", "qwen-turbo-latest", "qwen-turbo-2025-04-28", "qwen-turbo-2024-11-01",
    "qwen-flash", "qwen-flash-latest", "qwen-flash-2025-07-28"
  ];
  
  return commercialModels.includes(model);
}

/**
 * Helper function to check if a model is an open-source Qwen model
 */
export function isQwenOpenSourceModel(model: string): boolean {
  return model.startsWith("qwen3") ||
         model.startsWith("qwen2.5") ||
         model.startsWith("qwen2") ||
         model.startsWith("qwen1.5") ||
         model.startsWith("qwq");
}

/**
 * Helper function to check if a model is a thinking-only mode model
 */
export function isQwenThinkingOnlyModel(model: string): boolean {
  const thinkingOnlyModels = [
    "qwen3-next-80b-a3b-thinking",
    "qwen3-235b-a22b-thinking-2507",
    "qwen3-30b-a3b-thinking-2507"
  ];
  
  return thinkingOnlyModels.includes(model);
}

/**
 * Helper function to check if a model supports multimodal features (Qwen-Omni)
 */
export function isQwenOmniModel(model: string): boolean {
  return model.includes("omni");
}

/**
 * Helper function to check if a model supports vision features
 */
export function isQwenVisionModel(model: string): boolean {
  return model.includes("vl") || model.includes("vision");
}

/**
 * Helper function to check if a model supports coder features
 */
export function isQwenCoderModel(model: string): boolean {
  return model.includes("coder");
}
