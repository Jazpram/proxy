import { Request } from "express";
import { assertNever } from "../utils";
import {
  getTokenCount as getClaudeTokenCount,
  init as initClaude,
} from "./claude";
import {
  estimateGoogleAITokenCount,
  getOpenAIImageCost,
  getTokenCount as getOpenAITokenCount,
  init as initOpenAi,
} from "./openai";
import {
  getTokenCount as getMistralAITokenCount,
  init as initMistralAI,
} from "./mistral";
import { APIFormat } from "../key-management";
import {
  AnthropicChatMessage,
  GoogleAIChatMessage,
  MistralAIChatMessage,
  OpenAIChatMessage,
} from "../api-schemas";
import { countTokensRemote as countAnthropicTokensRemote } from "./anthropic-remote";
import { countTokensRemote as countAwsTokensRemote } from "./aws-remote";
import { countTokensRemote as countGcpTokensRemote } from "./gcp-remote";
import { AnthropicKey } from "../key-management/anthropic/provider";
import { AwsBedrockKey } from "../key-management/aws/provider";
import { GcpKey } from "../key-management/gcp/provider";
import { logger } from "../../logger";
import { config } from "../../config";
import { findByAnthropicId } from "../claude-models";

const log = logger.child({ module: "tokenizer" });


export async function init() {
  initClaude();
  initOpenAi();
  initMistralAI();
}

type OpenAIChatTokenCountRequest = {
  prompt: OpenAIChatMessage[];
  completion?: never;
  service: "openai" | "openai-responses";
};

type AnthropicChatTokenCountRequest = {
  prompt: { system: string; messages: AnthropicChatMessage[] };
  completion?: never;
  service: "anthropic-chat";
};

type GoogleAIChatTokenCountRequest = {
  prompt: GoogleAIChatMessage[];
  completion?: never;
  service: "google-ai";
};

type MistralAIChatTokenCountRequest = {
  prompt: string | MistralAIChatMessage[];
  completion?: never;
  service: "mistral-ai" | "mistral-text";
};

type FlatPromptTokenCountRequest = {
  prompt: string;
  completion?: never;
  service: "openai-text" | "anthropic-text" | "google-ai";
};

type StringCompletionTokenCountRequest = {
  prompt?: never;
  completion: string;
  service: APIFormat;
};

type OpenAIImageCompletionTokenCountRequest = {
  prompt?: never;
  completion?: never;
  service: "openai-image";
};

/**
 * Tagged union via `service` field of the different types of requests that can
 * be made to the tokenization service, for both prompts and completions
 */
type TokenCountRequest = { req: Request } & (
  | OpenAIChatTokenCountRequest
  | AnthropicChatTokenCountRequest
  | GoogleAIChatTokenCountRequest
  | MistralAIChatTokenCountRequest
  | FlatPromptTokenCountRequest
  | StringCompletionTokenCountRequest
  | OpenAIImageCompletionTokenCountRequest
);

type TokenCountResult = {
  token_count: number;
  /** Additional tokens for reasoning, if applicable. */
  reasoning_tokens?: number;
  tokenizer: string;
  tokenization_duration_ms: number;
};

export async function countTokens({
  req,
  service,
  prompt,
  completion,
}: TokenCountRequest): Promise<TokenCountResult> {
  const time = process.hrtime();
  // For prompt counting, try remote APIs first (only when enabled, have a key, and counting prompts)
  if (config.useRemoteTokenCounting && prompt && req.key) {
    try {
      switch (service) {
        case "anthropic-chat": {
          if (req.service === "anthropic" && req.key.service === "anthropic") {
            const result = await countAnthropicTokensRemote(
              {
                model: req.body.model,
                messages: prompt.messages,
                system: prompt.system,
                tools: req.body.tools,
              },
              req.key as AnthropicKey
            );
            return { ...result, tokenization_duration_ms: getElapsedMs(time) };
          }
          break;
        }
        case "anthropic-text": {
          if (req.service === "anthropic" && req.key.service === "anthropic") {
            // Anthropic's API doesn't support text completion counting, fall through to local
            break;
          }
          break;
        }
      }

      // For AWS Bedrock services, use AWS token counting
      if (req.service === "aws" && req.key.service === "aws") {
        if (service === "anthropic-chat") {
          // Convert Anthropic model ID to AWS Bedrock model ID
          const anthropicModelId = req.body.model;
          const claudeMapping = findByAnthropicId(anthropicModelId);
          const awsModelId = claudeMapping?.awsId || anthropicModelId;

          // Build the request body in Anthropic format - must include all required fields
          const bodyObj: any = {
            messages: req.body.messages,
            max_tokens: req.body.max_tokens,
            anthropic_version: req.body.anthropic_version || "bedrock-2023-05-31",
          };
          if (req.body.system) bodyObj.system = req.body.system;
          if (req.body.tools) bodyObj.tools = req.body.tools;
          if (req.body.tool_choice) bodyObj.tool_choice = req.body.tool_choice;

          // AWS expects the body as a base64-encoded string
          const bodyJson = JSON.stringify(bodyObj);
          const bodyBase64 = Buffer.from(bodyJson, "utf-8").toString("base64");

          const result = await countAwsTokensRemote(
            awsModelId,
            {
              input: {
                invokeModel: {
                  body: bodyBase64,
                },
              },
            },
            req.key as AwsBedrockKey
          );
          return { ...result, tokenization_duration_ms: getElapsedMs(time) };
        }
      }

      // For GCP Vertex AI services, use GCP token counting
      if (req.service === "gcp" && req.key.service === "gcp") {
        // GCP uses a different format, would need transformation
        // For now, fall through to local counting
      }
    } catch (error) {
      // Fall through to local tokenization
      log.debug(
        { error: (error as Error).message, service },
        "Remote token counting failed, using local tokenizer"
      );
    }
  }

  // Fall back to local tokenization

  switch (service) {
    case "anthropic-chat":
    case "anthropic-text":
      return {
        ...(await getClaudeTokenCount(prompt ?? completion)),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "openai":
    case "openai-text":
    case "openai-responses":
      return {
        ...(await getOpenAITokenCount(prompt ?? completion, req.body.model)),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "openai-image":
      return {
        ...getOpenAIImageCost({
          model: req.body.model,
          quality: req.body.quality,
          resolution: req.body.size,
          n: parseInt(req.body.n, 10) || null,
        }),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "google-ai":
      // TODO: Can't find a tokenization library for Gemini. There is an API
      // endpoint for it but it adds significant latency to the request.
      return {
        ...estimateGoogleAITokenCount(prompt ?? (completion || [])),
        tokenization_duration_ms: getElapsedMs(time),
      };
    case "mistral-ai":
    case "mistral-text":
      return {
        ...getMistralAITokenCount(prompt ?? completion),
        tokenization_duration_ms: getElapsedMs(time),
      };
    default:
      assertNever(service);
  }
}

function getElapsedMs(time: [number, number]) {
  const diff = process.hrtime(time);
  return diff[0] * 1000 + diff[1] / 1e6;
}
