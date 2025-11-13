import { GroqKey } from "./provider";
import { config } from "../../../config";
import { logger } from "../../../logger";

const CHECK_TIMEOUT = 10000;

export class GroqKeyChecker {
  private log = logger.child({ module: "key-checker", service: "groq" });

  constructor(private readonly update: (hash: string, key: Partial<GroqKey>) => void) {
    this.log.info("GroqKeyChecker initialized");
  }

  public async checkKey(key: GroqKey): Promise<void> {
    this.log.info({ hash: key.hash }, "Starting key validation check");
    try {
      const result = await this.validateKey(key);
      this.handleCheckResult(key, result);
    } catch (error) {
      if (error instanceof Error) {
        this.log.error({ error, hash: key.hash }, "Key check failed");
      }
      this.update(key.hash, { lastChecked: Date.now() });
    }
  }

  protected async validateKey(key: GroqKey): Promise<{
    isValid: boolean;
    isOverQuota: boolean;
    isRevoked?: boolean;
    error?: string;
    retryAfter?: number; // minutes to wait before retry
  }> {
    const log = logger.child({ module: "key-checker", service: "groq", keyHash: key.hash });

    try {
      // Test the key by making a simple request to Groq's models endpoint
      const response = await fetch("https://api.groq.com/openai/v1/models", {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${key.key}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      log.debug({ status: response.status }, "Key check response");

      if (response.status === 200) {
        // Key is valid
        return { isValid: true, isOverQuota: false };
      }

      const errorText = await response.text();

      // Client Error Codes
      switch (response.status) {
        case 400: // Bad Request - syntax error
          log.warn({ status: response.status, error: errorText }, "Bad Request - request format invalid");
          return {
            isValid: false,
            isOverQuota: false,
            error: `Bad Request - invalid request format (${response.status})`,
            retryAfter: 5 // retry in 5 minutes
          };

        case 401: // Unauthorized - invalid credentials
          log.warn({ status: response.status, error: errorText }, "Unauthorized - invalid API key");
          return {
            isValid: false,
            isOverQuota: false,
            isRevoked: true,
            error: `Unauthorized - invalid API key (${response.status})`
          };

        case 403: // Forbidden - permission restrictions
          log.warn({ status: response.status, error: errorText }, "Forbidden - insufficient permissions");
          return {
            isValid: false,
            isOverQuota: false,
            isRevoked: true,
            error: `Forbidden - insufficient permissions (${response.status})`
          };

        case 404: // Not Found - resource doesn't exist
          log.warn({ status: response.status, error: errorText }, "Not Found - resource unavailable");
          return {
            isValid: false,
            isOverQuota: false,
            error: `Not Found - resource unavailable (${response.status})`,
            retryAfter: 10 // retry in 10 minutes (might be temporary)
          };

        case 413: // Request Entity Too Large
          log.warn({ status: response.status, error: errorText }, "Request Entity Too Large");
          return {
            isValid: true, // key is valid, just request too large
            isOverQuota: false,
            error: `Request Entity Too Large (${response.status})`,
            retryAfter: 1 // retry in 1 minute
          };

        case 422: // Unprocessable Entity - semantic errors
          log.warn({ status: response.status, error: errorText }, "Unprocessable Entity - semantic error");
          return {
            isValid: true, // key is valid, just semantic issues
            isOverQuota: false,
            error: `Unprocessable Entity - semantic error (${response.status})`,
            retryAfter: 2 // retry in 2 minutes
          };

        case 424: // Failed Dependency
          log.warn({ status: response.status, error: errorText }, "Failed Dependency - dependent request failed");
          return {
            isValid: true, // key is valid, dependency issue
            isOverQuota: false,
            error: `Failed Dependency - authentication issue with dependency (${response.status})`,
            retryAfter: 15 // retry in 15 minutes
          };

        case 429: // Too Many Requests - rate limited
          log.warn({ status: response.status, error: errorText }, "Too Many Requests - rate limit exceeded");
          return {
            isValid: true,
            isOverQuota: true,
            error: `Too Many Requests - rate limit exceeded (${response.status})`,
            retryAfter: 5 // retry in 5 minutes
          };

        case 498: // Custom: Flex Tier Capacity Exceeded
          log.warn({ status: response.status, error: errorText }, "Flex Tier Capacity Exceeded");
          return {
            isValid: true,
            isOverQuota: true,
            error: `Flex Tier Capacity Exceeded (${response.status})`,
            retryAfter: 10 // retry in 10 minutes
          };

        // Server Error Codes
        case 500: // Internal Server Error
          log.error({ status: response.status, error: errorText }, "Internal Server Error");
          throw new Error(`Internal Server Error: ${response.status}`);

        case 502: // Bad Gateway
          log.error({ status: response.status, error: errorText }, "Bad Gateway - upstream server error");
          throw new Error(`Bad Gateway: ${response.status}`);

        case 503: // Service Unavailable
          log.error({ status: response.status, error: errorText }, "Service Unavailable - service overloaded/maintenance");
          throw new Error(`Service Unavailable: ${response.status}`);

        default:
          log.error({ status: response.status, error: errorText }, "Unexpected Groq error");
          return {
            isValid: false,
            isOverQuota: false,
            error: `Unexpected error (${response.status}): ${errorText}`,
            retryAfter: 30 // retry in 30 minutes for unknown errors
          };
      }
    } catch (error) {
      log.error({ error }, "Failed to check Groq key");
      throw error;
    }
  }

  protected async testModelAccess(key: GroqKey, model: string): Promise<boolean> {
    const log = logger.child({ module: "key-checker", service: "groq", keyHash: key.hash, model });

    try {
      // Test with a minimal chat completion request
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(15000), // 15 second timeout
      });

      if (response.status === 200) {
        log.debug("Model access confirmed");
        return true;
      }

      const errorText = await response.text();

      switch (response.status) {
        case 400: // Bad Request
          log.debug({ status: response.status, error: errorText }, "Model validation failed - bad request format");
          return false;

        case 401: // Unauthorized
          log.warn({ status: response.status, error: errorText }, "Model access failed - unauthorized");
          return false;

        case 403: // Forbidden
          log.warn({ status: response.status, error: errorText }, "Model access failed - forbidden");
          return false;

        case 404: // Not Found
          log.debug({ status: response.status, error: errorText }, "Model not available for this key");
          return false;

        case 413: // Request Entity Too Large
          log.debug({ status: response.status, error: errorText }, "Model test request too large");
          return false;

        case 422: // Unprocessable Entity
          log.debug({ status: response.status, error: errorText }, "Model validation failed - semantic error");
          return false;

        case 424: // Failed Dependency
          log.debug({ status: response.status, error: errorText }, "Model access failed - dependency issue");
          return false;

        case 429: // Too Many Requests
          log.debug({ status: response.status, error: errorText }, "Model test rate limited");
          return false;

        case 498: // Flex Tier Capacity Exceeded
          log.debug({ status: response.status, error: errorText }, "Model test failed - flex tier at capacity");
          return false;

        case 500: // Internal Server Error
        case 502: // Bad Gateway
        case 503: // Service Unavailable
          log.debug({ status: response.status, error: errorText }, "Model test failed due to server error");
          return false;

        default:
          log.debug({ status: response.status, error: errorText }, "Model test failed - unexpected error");
          return false;
      }
    } catch (error) {
      log.error({ error }, "Failed to test model access");
      return false;
    }
  }

  protected getModelsToTest(): string[] {
    // Common Groq models to test against
    return [
      "llama-3.1-8b-instant",
      "llama-3.1-70b-versatile",
      "mixtral-8x7b-32768",
      "gemma-7b-it",
    ];
  }

  private handleCheckResult(key: GroqKey, result: {
    isValid: boolean;
    isOverQuota: boolean;
    isRevoked?: boolean;
    error?: string;
    retryAfter?: number; // minutes to wait before retry
  }) {
    this.log.info({
      hash: key.hash,
      isValid: result.isValid,
      isOverQuota: result.isOverQuota,
      isRevoked: result.isRevoked,
      retryAfter: result.retryAfter
    }, "Key validation result");

    const now = Date.now();
    let lastChecked = now;

    // Calculate next check time if retryAfter is specified
    if (result.retryAfter) {
      // Set lastChecked to force a recheck after the specified minutes
      const retryTime = result.retryAfter * 60 * 1000; // convert minutes to milliseconds
      lastChecked = now - (6 * 60 * 60 * 1000 - retryTime); // KEY_CHECK_PERIOD is 6 hours
    }

    if (result.isValid) {
      this.update(key.hash, {
        isDisabled: false,
        isOverQuota: false,
        isRevoked: false,
        lastChecked: now,
      });
      return;
    }

    // Key is invalid or over quota
    if (result.isRevoked) {
      this.log.warn({ hash: key.hash, error: result.error }, "Key has been revoked, disabling");
      this.update(key.hash, {
        isDisabled: true,
        isRevoked: true,
        isOverQuota: false,
        lastChecked: now,
      });
      return;
    }

    if (result.isOverQuota) {
      this.log.warn({ hash: key.hash, error: result.error, retryAfter: result.retryAfter }, "Key has exceeded its quota or is rate limited, disabling temporarily");
      this.update(key.hash, {
        isDisabled: true,
        isOverQuota: true,
        isRevoked: false,
        lastChecked: lastChecked,
      });
      return;
    }

    // General error case - some errors might be temporary
    if (result.retryAfter) {
      this.log.warn({ hash: key.hash, error: result.error, retryAfter: result.retryAfter }, "Key validation failed temporarily, will retry");
      this.update(key.hash, {
        isDisabled: true,
        isOverQuota: false,
        isRevoked: false,
        lastChecked: lastChecked,
      });
      return;
    }

    // Permanent error case
    this.log.warn({ hash: key.hash, error: result.error }, "Key validation failed permanently, disabling");
    this.update(key.hash, {
      isDisabled: true,
      isOverQuota: false,
      isRevoked: false,
      lastChecked: now,
    });
  }
}