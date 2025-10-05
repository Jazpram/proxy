import { AnthropicChatMessage } from "../api-schemas";
import { getAxiosInstance } from "../network";
import { logger } from "../../logger";
import { AnthropicKey } from "../key-management/anthropic/provider";

const log = logger.child({ module: "tokenizer", service: "anthropic-remote" });

export interface AnthropicTokenCountRequest {
  model: string;
  messages: AnthropicChatMessage[];
  system?: string | Array<{ type: string; text: string }>;
  tools?: unknown[];
}

export interface AnthropicTokenCountResponse {
  input_tokens: number;
}

/**
 * Counts tokens using Anthropic's remote token counting API endpoint.
 * https://docs.claude.com/en/docs/build-with-claude/token-counting
 */
export async function countTokensRemote(
  request: AnthropicTokenCountRequest,
  key: AnthropicKey
): Promise<{ token_count: number; tokenizer: string }> {
  const axios = getAxiosInstance();

  try {
    const response = await axios.post<AnthropicTokenCountResponse>(
      "https://api.anthropic.com/v1/messages/count_tokens",
      request,
      {
        headers: {
          "x-api-key": key.key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 5000, // 5 second timeout
      }
    );

    log.debug(
      {
        model: request.model,
        input_tokens: response.data.input_tokens,
      },
      "Counted tokens via Anthropic API"
    );

    return {
      token_count: response.data.input_tokens,
      tokenizer: "anthropic-remote-api",
    };
  } catch (error: any) {
    log.warn(
      {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      },
      "Failed to count tokens via Anthropic API, will fall back to local tokenizer"
    );
    throw error;
  }
}