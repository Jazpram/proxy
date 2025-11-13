// src/shared/key-management/groq/checker.ts

import { AxiosError } from "axios";
import { getAxiosInstance } from "../../network";
import { KeyCheckerBase } from "../key-checker-base";
import type { GroqKey, GroqKeyProvider, GroqKeyStatus } from "./provider";

const axios = getAxiosInstance();

const MIN_CHECK_INTERVAL = 3 * 1000;
const KEY_CHECK_PERIOD = 1000 * 60 * 60 * 2; // Check every 2 hours
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

type ModelsResponse = {
  data: Array<{
    id: string;
    object: string;
    created: number;
    owned_by: string;
  }>;
};

type ErrorResponse = {
  error: {
    message: string;
    type: string;
    code?: string | number;
  };
};

type KeyInfoResult = ModelsResponse | ErrorResponse;

type UpdateFn = typeof GroqKeyProvider.prototype.update;

export class GroqKeyChecker extends KeyCheckerBase<GroqKey> {
  constructor(keys: GroqKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "groq",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: GroqKey) {
    const { status, info, rateLimitInfo } = await this.testKey(key);
    this.updateKey(key.hash, { status, info, rateLimitInfo });
    this.log.info(
      { key: key.hash, status, info },
      "Checked Groq key."
    );
  }

  protected handleAxiosError(key: GroqKey, error: AxiosError) {
    if (error.response?.status === 429) {
      this.updateKey(key.hash, {
        status: 'RATE_LIMITED',
        info: 'Rate limit exceeded during check.' ,
      });
      return;
    }

    if (error.response?.status === 401) {
      this.updateKey(key.hash, {
        status: 'INVALID',
        info: 'Invalid API key.' ,
        isDisabled: true,
        isRevoked: true,
      });
      return;
    }

    this.log.error(
      { key: key.hash, error: error.message },
      "Network error while checking key; trying this key again in an hour."
    );
    const oneHour = 60 * 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneHour);
    this.updateKey(key.hash, { lastChecked: next });
  }

  private async makeRequest<T extends KeyInfoResult>(
    key: GroqKey,
    endpoint: string
  ): Promise<{ status: number; data: T }> {
    const headers = {
      'Authorization': `Bearer ${key.key}`,
      'Content-Type': 'application/json'
    };

    try {
      const response = await axios.get<T>(`${GROQ_BASE_URL}/${endpoint}`, { headers });
      return { status: response.status, data: response.data as T };
    } catch (e: any) {
      const error = e as AxiosError<ErrorResponse>;
      return {
        status: error.response?.status || 500,
        data: error.response?.data as T || {
          error: { message: error.message, type: 'network_error' }
        } as T
      };
    }
  }

  private async testKey(key: GroqKey): Promise<{
    status: GroqKeyStatus;
    info: string;
    rateLimitInfo?: GroqKey['rateLimitInfo'];
  }> {
    // Test by listing available models - this is a lightweight way to validate the key
    const result = await this.makeRequest<ModelsResponse>(key, "models");

    if (result.status === 200 && this.isModelsResponse(result.data)) {
      const models = result.data.data;
      const modelCount = models.length;

      // Extract rate limit headers if present
      let rateLimitInfo: GroqKey['rateLimitInfo'] | undefined;

      return {
        status: 'ACTIVE',
        info: `Valid key with access to ${modelCount} models`,
        rateLimitInfo,
      };
    }

    if (this.isErrorResponse(result.data)) {
      const errorMsg = result.data.error.message;
      const errorType = result.data.error.type;

      if (result.status === 401) {
        return {
          status: 'INVALID',
          info: `Invalid key: ${errorMsg}`,
        };
      }

      if (result.status === 429) {
        return {
          status: 'RATE_LIMITED',
          info: `Rate limited: ${errorMsg}`,
        };
      }

      return {
        status: 'UNKNOWN',
        info: `Error (${errorType}): ${errorMsg}`,
      };
    }

    return {
      status: 'UNKNOWN',
      info: `Unexpected response status: ${result.status}`,
    };
  }

  private isModelsResponse(data: any): data is ModelsResponse {
    return data && Array.isArray(data.data) && data.data.every((item: any) =>
      item.id && item.object && item.created !== undefined
    );
  }

  private isErrorResponse(data: any): data is ErrorResponse {
    return data && data.error && data.error.message;
  }
}