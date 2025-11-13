import { z } from "zod";
import { OPENAI_OUTPUT_MAX } from "./openai";
// import { GroqModelFamily } from "../../models"; // ModelFamily import causes circular dependency

// Define the content types for multimodal messages (Groq supports some vision models)
export const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string()
});

export const ImageUrlContentSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.union([
    // URL format (https://...)
    z.string().url(),
    // Base64 format (data:image/jpeg;base64,...)
    z.string().regex(/^data:image\/(jpeg|png|gif|webp);base64,/),
    // Object format (might contain detail or url properties)
    z.object({
      url: z.string(),
      detail: z.enum(["low", "high"]).optional()
    }),
    // Allow any string for maximum compatibility
    z.string()
  ])
});

export const ContentItemSchema = z.union([TextContentSchema, ImageUrlContentSchema]);

// Export types for the content schemas
export type TextContent = z.infer<typeof TextContentSchema>;
export type ImageUrlContent = z.infer<typeof ImageUrlContentSchema>;
export type ContentItem = z.infer<typeof ContentItemSchema>;

// Helper function to check if a model supports vision
export function isGroqVisionModel(model: string): boolean {
  const modelLower = model.toLowerCase();
  // Groq vision models typically have "vision" in the name
  // Currently, Groq offers models like llama-3.1-8b-vision, etc.
  return modelLower.includes("vision") || modelLower.includes("llava");
}

// Helper function to check if a model supports tool use
export function isGroqToolModel(model: string): boolean {
  const modelLower = model.toLowerCase();
  // Most newer Groq models support tool use
  return modelLower.includes("llama") || modelLower.includes("mixtral") || modelLower.includes("gemma");
}

// Helper function to check if a model supports JSON mode
export function isGroqJsonModel(model: string): boolean {
  const modelLower = model.toLowerCase();
  // Most recent Groq models support JSON mode
  return modelLower.includes("llama") || modelLower.includes("mixtral");
}

// Main Groq chat message schema
const GroqChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  // Support both string content (for backwards compatibility) and array of content items (for multimodal)
  content: z.union([
    z.string().nullable(),
    z.array(ContentItemSchema)
  ]),
  // Tool call fields
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
});

const GroqMessagesSchema = z.array(GroqChatMessageSchema);

// Basic chat completions schema
export const GroqV1ChatCompletionsSchema = z.object({
  model: z.string(),
  messages: GroqMessagesSchema,
  temperature: z.number().min(0).max(2).optional().default(1),
  top_p: z.number().min(0).max(1).optional().default(1),
  max_completion_tokens: z.coerce
    .number()
    .int()
    .positive()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  max_tokens: z.coerce // Deprecated parameter, but kept for backward compatibility
    .number()
    .int()
    .positive()
    .nullish()
    .transform((v) => Math.min(v ?? OPENAI_OUTPUT_MAX, OPENAI_OUTPUT_MAX)),
  stream: z.boolean().optional().default(false),
  // Groq supports stop as string or array
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .default([])
    .transform((v) => (Array.isArray(v) ? v : [v])),
  seed: z.number().int().min(0).optional(),
  response_format: z
    .object({ type: z.enum(["text", "json_object"]), json_schema: z.any().optional() })
    .optional(),
  stream_options: z.object({
    include_usage: z.boolean()
  }).optional(),
  user: z.string().optional(),
  // Fields to support function calling
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([
    z.string(),
    z.object({
      type: z.literal("function"),
      function: z.object({
        name: z.string()
      })
    })
  ]).optional(),
  // Advanced parameters (Groq supports many of these)
  frequency_penalty: z.number().min(-2).max(2).optional().default(0),
  presence_penalty: z.number().min(-2).max(2).optional().default(0),
  logprobs: z.boolean().optional().default(false),
  top_logprobs: z.number().int().min(0).max(5).optional(),
  // Groq-specific parameters
  repetition_penalty: z.number().min(0).max(2).optional().default(1.0),
});

// Helper function to convert multimodal content to string format for text-only models
export function contentToString(content: string | any[] | null): string {
  if (typeof content === "string") {
    return content || "";
  } else if (Array.isArray(content)) {
    // For multimodal content, extract only the text parts
    // Images are not supported in text-only templates
    return content
      .filter(item => item.type === "text")
      .map(item => (item as any).text)
      .join("\n\n");
  }
  return "";
}

// Groq model information for dynamic model loading
export const GROQ_MODEL_FAMILIES = ["groq"] as const;