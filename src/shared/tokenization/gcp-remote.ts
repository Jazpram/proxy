import { getAxiosInstance } from "../network";
import { logger } from "../../logger";
import { GcpKey } from "../key-management/gcp/provider";
import { getCredentialsFromGcpKey, refreshGcpAccessToken } from "../key-management/gcp/oauth";

const log = logger.child({ module: "tokenizer", service: "gcp-remote" });

export interface GcpTokenCountRequest {
  contents: Array<{
    role: string;
    parts: Array<{
      text?: string;
      inline_data?: {
        mime_type: string;
        data: string;
      };
    }>;
  }>;
  systemInstruction?: {
    parts: Array<{
      text: string;
    }>;
  };
  tools?: unknown[];
}

export interface GcpTokenCountResponse {
  totalTokens: number;
  totalBillableCharacters?: number;
  promptTokensDetails?: Array<{
    modality: string;
    tokenCount: number;
  }>;
}

/**
 * Counts tokens using GCP Vertex AI's remote token counting API endpoint.
 * https://cloud.google.com/vertex-ai/docs/generative-ai/model-reference/count-tokens
 */
export async function countTokensRemote(
  model: string,
  request: GcpTokenCountRequest,
  key: GcpKey
): Promise<{ token_count: number; tokenizer: string }> {
  const axios = getAxiosInstance();

  // Ensure we have a valid access token
  const now = Date.now();
  if (!key.accessToken || now >= key.accessTokenExpiresAt) {
    const [token, expiresIn] = await refreshGcpAccessToken(key);
    key.accessToken = token;
    key.accessTokenExpiresAt = now + expiresIn * 1000;
  }

  const { projectId, region } = await getCredentialsFromGcpKey(key);

  // Extract just the model name (e.g., "gemini-1.5-pro" from full model ID)
  // GCP model IDs are typically like "gemini-1.5-pro-001" or just "gemini-1.5-pro"
  let modelName = model;
  if (model.includes("/")) {
    // Handle full resource names like "projects/.../models/gemini-1.5-pro"
    modelName = model.split("/").pop()!;
  }

  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${modelName}:countTokens`;

  try {
    const response = await axios.post<GcpTokenCountResponse>(
      url,
      request,
      {
        headers: {
          "Authorization": `Bearer ${key.accessToken}`,
          "content-type": "application/json",
        },
        timeout: 5000, // 5 second timeout
      }
    );

    log.debug(
      {
        model: modelName,
        total_tokens: response.data.totalTokens,
        details: response.data.promptTokensDetails,
      },
      "Counted tokens via GCP Vertex AI API"
    );

    return {
      token_count: response.data.totalTokens,
      tokenizer: "gcp-vertex-ai-remote-api",
    };
  } catch (error: any) {
    log.warn(
      {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      },
      "Failed to count tokens via GCP Vertex AI API, will fall back to local tokenizer"
    );
    throw error;
  }
}