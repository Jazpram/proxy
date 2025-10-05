import { z } from "zod";
import { OPENAI_OUTPUT_MAX } from "./openai";

/**
 * Helper function to check if a model is from GLM
 */
export function isGlmModel(model: string): boolean {
  return model.startsWith("glm");
}

/**
 * Helper function to check if a model supports thinking capability
 */
export function isGlmThinkingModel(model: string): boolean {
  // GLM-4.5 and GLM-Z1 series support thinking mode
  return model.includes("glm-4.5") || model.includes("glm-z1") || model.includes("glm-4.6");
}

/**
 * Helper function to check if a model supports vision features
 */
export function isGlmVisionModel(model: string): boolean {
  return model === "glm-4v";
}

// Basic chat message schema - GLM uses OpenAI-compatible format
const GlmChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.union([z.string(), z.null(), z.array(z.any())]).nullable(),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
});

const GlmMessagesSchema = z.array(GlmChatMessageSchema);

// Schema for GLM chat completions (OpenAI-compatible)
export const GlmV1ChatCompletionsSchema = z.object({
  model: z.string(),
  messages: GlmMessagesSchema,
  temperature: z.number().min(0).max(1).optional().default(0.6),
  top_p: z.number().min(0).max(1).optional().default(0.95),
  max_tokens: z.coerce
    .number()
    .int()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  stream: z.boolean().optional().default(false),
  stream_options: z.object({
    include_usage: z.boolean().optional()
  }).optional(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .default([])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  response_format: z
    .object({
      type: z.enum(["text", "json_object"]),
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
  // GLM-specific parameters
  thinking: z.object({
    type: z.enum(["enabled", "disabled"]).optional(),
  }).optional(),
  do_sample: z.boolean().optional().default(true),
  request_id: z.string().optional(),
  user_id: z.string().optional(),
});

/**
 * Helper function to normalize messages for GLM API
 * GLM uses the standard OpenAI message format, so no transformation is needed
 */
export function normalizeGlmMessages(messages: any[]): any[] {
  return messages;
}

/**
 * Helper function to check if a model supports function calling
 */
export function isGlmFunctionCallingModel(model: string): boolean {
  // Most GLM models support function calling
  return !model.includes("flash"); // Flash models may have limited function support
}