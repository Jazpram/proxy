/* This file is fucking horrendous, sorry */
// TODO: extract all per-service error response handling into its own modules
import { Request, Response } from "express";
import * as http from "http";
import { config } from "../../../config";
import { HttpError, RetryableError } from "../../../shared/errors";
import { keyPool, GoogleAIKey } from "../../../shared/key-management";
import { logger } from "../../../logger";
import { getOpenAIModelFamily, GoogleAIModelFamily } from "../../../shared/models";
import { countTokens } from "../../../shared/tokenization";
import {
  incrementPromptCount,
  incrementTokenCount,
} from "../../../shared/users/user-store";
import { assertNever } from "../../../shared/utils";
import { reenqueueRequest, trackWaitTime } from "../../queue";
import { refundLastAttempt } from "../../rate-limit";
import {
  getCompletionFromBody,
  isImageGenerationRequest,
  isTextGenerationRequest,
  sendProxyError,
} from "../common";
import { handleBlockingResponse } from "./handle-blocking-response";
import { handleStreamedResponse } from "./handle-streamed-response";
import { logPrompt } from "./log-prompt";
import { logEvent } from "./log-event";
import { saveImage } from "./save-image";

/**
 * Either decodes or streams the entire response body and then resolves with it.
 * @returns The response body as a string or parsed JSON object depending on the
 * response's content-type.
 */
export type RawResponseBodyHandler = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response
) => Promise<string | Record<string, any>>;

export type ProxyResHandlerWithBody = (
  proxyRes: http.IncomingMessage,
  req: Request,
  res: Response,
  /**
   * This will be an object if the response content-type is application/json,
   * or if the response is a streaming response. Otherwise it will be a string.
   */
  body: string | Record<string, any>
) => Promise<void>;
export type ProxyResMiddleware = ProxyResHandlerWithBody[] | undefined;

/**
 * Returns a on.proxyRes handler that executes the given middleware stack after
 * the common proxy response handlers have processed the response and decoded
 * the body.  Custom middleware won't execute if the response is determined to
 * be an error from the upstream service as the response will be taken over by
 * the common error handler.
 *
 * For streaming responses, the handleStream middleware will block remaining
 * middleware from executing as it consumes the stream and forwards events to
 * the client. Once the stream is closed, the finalized body will be attached
 * to res.body and the remaining middleware will execute.
 *
 * @param apiMiddleware - Custom middleware to execute after the common response
 * handlers. These *only* execute for non-streaming responses, so should be used
 * to transform non-streaming responses into the desired format.
 */
export const createOnProxyResHandler = (apiMiddleware: ProxyResMiddleware) => {
  return async (
    proxyRes: http.IncomingMessage,
    req: Request,
    res: Response
  ) => {
    // Proxied request has by now been sent to the upstream API, so we revert
    // tracked mutations that were only needed to send the request.
    // This generally means path adjustment, headers, and body serialization.
    if (req.changeManager) {
      req.changeManager.revert();
    }

    const initialHandler = req.isStreaming
      ? handleStreamedResponse
      : handleBlockingResponse;
    let lastMiddleware = initialHandler.name;

    if (Buffer.isBuffer(req.body)) {
      req.body = JSON.parse(req.body.toString());
    }

    try {
      const body = await initialHandler(proxyRes, req, res);
      const middlewareStack: ProxyResMiddleware = [];

      if (req.isStreaming) {
        // Handlers for streaming requests must never write to the response.
        middlewareStack.push(
          trackKeyRateLimit,
          countResponseTokens,
          incrementUsage,
          logPrompt,
          logEvent
        );
      } else {
        middlewareStack.push(
          trackKeyRateLimit,
          injectProxyInfo,
          handleUpstreamErrors,
          countResponseTokens,
          incrementUsage,
          copyHttpHeaders,
          saveImage,
          logPrompt,
          logEvent,
          ...(apiMiddleware ?? [])
        );
      }

      for (const middleware of middlewareStack) {
        lastMiddleware = middleware.name;
        await middleware(proxyRes, req, res, body);
      }

      trackWaitTime(req);
    } catch (error) {
      // Hack: if the error is a retryable rate-limit error, the request has
      // been re-enqueued and we can just return without doing anything else.
      if (error instanceof RetryableError) {
        return;
      }

      // Already logged and responded to the client by handleUpstreamErrors
      if (error instanceof HttpError) {
        if (!res.writableEnded) res.end();
        return;
      }

      const { stack, message } = error;
      const details = { stack, message, lastMiddleware, key: req.key?.hash };
      const description = `Error while executing proxy response middleware: ${lastMiddleware} (${message})`;

      if (res.headersSent) {
        req.log.error(details, description);
        if (!res.writableEnded) res.end();
        return;
      } else {
        req.log.error(details, description);
        res
          .status(500)
          .json({ error: "Internal server error", proxy_note: description });
      }
    }
  };
};

type ProxiedErrorPayload = {
  error?: Record<string, any>;
  message?: string;
  proxy_note?: string;
};

/**
 * Handles non-2xx responses from the upstream service.  If the proxied response
 * is an error, this will respond to the client with an error payload and throw
 * an error to stop the middleware stack.
 * On 429 errors, if request queueing is enabled, the request will be silently
 * re-enqueued.  Otherwise, the request will be rejected with an error payload.
 * @throws {HttpError} On HTTP error status code from upstream service
 */
const handleUpstreamErrors: ProxyResHandlerWithBody = async (
  proxyRes,
  req,
  res,
  body
) => {
  const statusCode = proxyRes.statusCode || 500;
  const statusMessage = proxyRes.statusMessage || "Internal Server Error";
  const service = req.key!.service;
  // Not an error, continue to next response handler
  if (statusCode < 400) return;

  // Parse the error response body
  let errorPayload: ProxiedErrorPayload;
  try {
    assertJsonResponse(body);
    errorPayload = body;
  } catch (parseError) {
    const strBody = String(body).slice(0, 128);
    req.log.error({ statusCode, strBody }, "Error body is not JSON");

    const details = {
      error: parseError.message,
      status: statusCode,
      statusMessage,
      proxy_note: `Proxy got back an error, but it was not in JSON format. This is likely a temporary problem with the upstream service. Response body: ${strBody}`,
    };

    sendProxyError(req, res, statusCode, statusMessage, details);
    throw new HttpError(statusCode, parseError.message);
  }

  // Extract the error type from the response body depending on the service
  if (service === "gcp") {
    if (Array.isArray(errorPayload)) {
      errorPayload = errorPayload[0];
    }
  }
  const errorType =
    errorPayload.error?.code ||
    errorPayload.error?.type ||
    getAwsErrorType(proxyRes.headers["x-amzn-errortype"]);

  req.log.warn(
    { statusCode, statusMessage, errorType, errorPayload, key: req.key?.hash },
    `API returned an error.`
  );

  // Try to convert response body to a ProxiedErrorPayload with message/type
  if (service === "aws") {
    errorPayload.error = { message: errorPayload.message, type: errorType };
    delete errorPayload.message;
  } else if (service === "gcp") {
    if (errorPayload.error?.code) {
      errorPayload.error = {
        message: errorPayload.error.message,
        type: errorPayload.error.status || errorPayload.error.code,
      };
    }
  }

  // Figure out what to do with the error
  // TODO: separate error handling for each service
  if (statusCode === 400) {
    switch (service) {
      case "openai":
      case "mistral-ai":
      case "azure":
        const filteredCodes = ["content_policy_violation", "content_filter"];
        if (filteredCodes.includes(errorPayload.error?.code)) {
          errorPayload.proxy_note = `Request was filtered by the upstream API's content moderation system. Modify your prompt and try again.`;
          refundLastAttempt(req);
        } else if (errorPayload.error?.code === "billing_hard_limit_reached") {
          // For some reason, some models return this 400 error instead of the
          // same 429 billing error that other models return.
          await handleOpenAIRateLimitError(req, errorPayload);
        } else {
          errorPayload.proxy_note = `The upstream API rejected the request. Check the error message for details.`;
        }
        break;
      case "deepseek":
        await handleDeepseekBadRequestError(req, errorPayload);
        break;
      case "glm":
        await handleGlmBadRequestError(req, errorPayload);
        break;
        case "xai":
          await handleXaiBadRequestError(req, errorPayload);
          break;
      case "anthropic":
      case "aws":
      case "gcp":
        await handleAnthropicAwsBadRequestError(req, errorPayload);
        break;
      case "google-ai":
        await handleGoogleAIBadRequestError(req, errorPayload);
        break;
      case "cohere":
        errorPayload.proxy_note = `The upstream Cohere API rejected the request. Check the error message for details.`;
        break;
      case "qwen":
        await handleQwenBadRequestError(req, errorPayload);
        break;
      case "moonshot":
        errorPayload.proxy_note = `The Moonshot API rejected the request. Check the error message for details.`;
        break;
      case "openrouter":
        await handleOpenRouterError(req, errorPayload);
        break;
      default:
        assertNever(service);
    }
  } else if (statusCode === 401) {
    // Universal 401 handling - authentication failed, retry with different key
    if (service === "openrouter") {
      await handleOpenRouterError(req, errorPayload);
    } else {
    keyPool.disable(req.key!, "revoked");
    await reenqueueRequest(req);
    throw new RetryableError(`${service} key authentication failed, retrying with different key.`);
    }
  } else if (statusCode === 402) {
    // Deepseek specific - insufficient balance
    if (service === "deepseek") {
      keyPool.disable(req.key!, "quota");
      await reenqueueRequest(req);
      throw new RetryableError("Deepseek key has insufficient balance, retrying with different key.");
    } else if (service === "openrouter") {
      await handleOpenRouterError(req, errorPayload);
    }
  } else if (statusCode === 405) {
    // Xai specific - method not allowed, treat as retryable
    if (service === "xai") {
      await reenqueueRequest(req);
      throw new RetryableError("XAI key method not allowed, retrying with different key.");
    }
  } else if (statusCode === 403) {
    switch (service) {
      case "anthropic":
        if (
          errorType === "permission_error" &&
          errorPayload.error?.message?.toLowerCase().includes("multimodal")
        ) {
          keyPool.update(req.key!, { allowsMultimodality: false });
          await reenqueueRequest(req);
          throw new RetryableError(
            "Claude request re-enqueued because key does not support multimodality."
          );
        } else {
          keyPool.disable(req.key!, "revoked");
          errorPayload.proxy_note = `Assigned API key is invalid or revoked, please try again.`;
        }
        return;
      case "aws":
        switch (errorType) {
          case "UnrecognizedClientException":
            // Key is invalid.
            keyPool.disable(req.key!, "revoked");
            await reenqueueRequest(req);
            throw new RetryableError("AWS key is invalid, retrying with different key.");
            break;
          case "AccessDeniedException":
            const isModelAccessError =
              errorPayload.error?.message?.includes(`specified model ID`);
            if (!isModelAccessError) {
              req.log.error(
                { key: req.key?.hash, model: req.body?.model },
                "Disabling key due to AccessDeniedException when invoking model. If credentials are valid, check IAM permissions."
              );
              keyPool.disable(req.key!, "revoked");
            }
            errorPayload.proxy_note = `API key doesn't have access to the requested resource. Model ID: ${req.body?.model}`;
            break;
          default:
            errorPayload.proxy_note = `Received 403 error. Key may be invalid.`;
        }
        return;
      case "mistral-ai":
      case "gcp":
        keyPool.disable(req.key!, "revoked");
        await reenqueueRequest(req);
        throw new RetryableError("GCP key is invalid, retrying with different key.");
      case "moonshot":
        keyPool.disable(req.key!, "revoked");
        await reenqueueRequest(req);
        throw new RetryableError("Moonshot key is invalid, retrying with different key.");
      case "xai":
        await reenqueueRequest(req);
        throw new RetryableError("XAI key lacks permissions, retrying with different key.");
      case "openrouter": // <--- ADDED OPENROUTER 403 LOGIC
        const message = errorPayload.error?.message || "";
        if (message.includes("Key limit exceeded")) {
            // 403 Forbidden с текстом "Key limit exceeded" - это исчерпание квоты.
            keyPool.disable(req.key!, "quota");
            await reenqueueRequest(req);
            throw new RetryableError("OpenRouter key limit exceeded (403), retrying with different key.");
        } else {
            // Любой другой 403, вероятно, является невалидным/отозванным ключом.
            keyPool.disable(req.key!, "revoked");
            await reenqueueRequest(req);
            throw new RetryableError("OpenRouter key is invalid or lacks permissions (403), retrying with different key.");
        }
    }
  } else if (statusCode === 429) {
    switch (service) {
      case "openai":
        await handleOpenAIRateLimitError(req, errorPayload);
        break;
      case "anthropic":
        await handleAnthropicRateLimitError(req, errorPayload);
        break;
      case "aws":
        await handleAwsRateLimitError(req, errorPayload);
        break;
      case "gcp":
        await handleGcpRateLimitError(req, errorPayload);
        break;
      case "azure":
      case "mistral-ai":
        await handleAzureRateLimitError(req, errorPayload);
        break;
      case "google-ai":
        await handleGoogleAIRateLimitError(req, errorPayload);
        break;
      case "deepseek":
        await handleDeepseekRateLimitError(req, errorPayload);
        break;
      case "glm":
        await handleGlmRateLimitError(req, errorPayload);
        break;
        case "xai":
          await handleXaiRateLimitError(req, errorPayload);
          break;
        case "cohere":
          await handleCohereRateLimitError(req, errorPayload);
          break;
        case "qwen":
          await handleQwenRateLimitError(req, errorPayload);
          break;
        case "moonshot":
          await handleMoonshotRateLimitError(req, errorPayload);
          break;
      case "openrouter":
          await handleOpenRouterError(req, errorPayload);
          break;
      default:
        assertNever(service as never);
    }
  } else if (statusCode === 404) {
    // Most likely model not found, but for xAI treat as retryable
    switch (service) {
      case "openai":
        if (errorType === "model_not_found") {
          const requestedModel = req.body.model;
          const modelFamily = getOpenAIModelFamily(requestedModel);
          errorPayload.proxy_note = `The key assigned to your prompt does not support the requested model (${requestedModel}, family: ${modelFamily}).`;
          req.log.error(
            { key: req.key?.hash, model: requestedModel, modelFamily },
            "Prompt was routed to a key that does not support the requested model."
          );
        }
        break;
      case "xai":
        await reenqueueRequest(req);
        throw new RetryableError("XAI API returned 404, retrying with different key.");
      case "anthropic":
      case "google-ai":
      case "mistral-ai":
      case "aws":
      case "gcp":
      case "azure":
      case "deepseek":
      case "glm":
      case "cohere":
      case "qwen":
        errorPayload.proxy_note = `The key assigned to your prompt does not support the requested model.`;
        break;
      case "openrouter":
          await handleOpenRouterError(req, errorPayload);
          break;
      default:
        assertNever(service as never);
    }
    
  } else if (statusCode === 500) {
    switch (service) {
      case "qwen":
        await handleQwenServerError(req, errorPayload);
        break;
      default:
        errorPayload.proxy_note = `Internal server error from upstream service.`;
        break;
    }
  } else if (statusCode === 503) {
    switch (service) {
      case "aws":
        // Re-enqueue on any 503 from AWS Bedrock
        req.log.warn(
          { key: req.key?.hash, errorType, errorPayload },
          `AWS Bedrock service unavailable (503). Re-enqueueing request.`
        );
        await reenqueueRequest(req);
        throw new RetryableError(
          "AWS Bedrock service unavailable (503), re-enqueued request."
        );
      case "qwen":
        await handleQwenServerOverloadError(req, errorPayload);
        break;
      default:
        errorPayload.proxy_note = `Upstream service unavailable. Try again later.`;
        break;
    }
  } else {
    errorPayload.proxy_note = `Unrecognized error from upstream service.`;
  }

  // Redact the OpenAI org id from the error message
  if (errorPayload.error?.message) {
    errorPayload.error.message = errorPayload.error.message.replace(
      /org-.{24}/gm,
      "org-xxxxxxxxxxxxxxxxxxx"
    );
  }

  // Send the error to the client
  sendProxyError(req, res, statusCode, statusMessage, errorPayload);

  // Re-throw the error to bubble up to onProxyRes's handler for logging
  throw new HttpError(statusCode, errorPayload.error?.message);
};

async function handleAnthropicAwsBadRequestError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const { error } = errorPayload;
  const isMissingPreamble = error?.message.startsWith(
    `prompt must start with "\n\nHuman:" turn`
  );

  // Some keys mandate a \n\nHuman: preamble, which we can add and retry
  if (isMissingPreamble) {
    req.log.warn(
      { key: req.key?.hash },
      "Request failed due to missing preamble. Key will be marked as such for subsequent requests."
    );
    keyPool.update(req.key!, { requiresPreamble: true });
    await reenqueueRequest(req);
    throw new RetryableError("Claude request re-enqueued to add preamble.");
  }

  // {"type":"error","error":{"type":"invalid_request_error","message":"Usage blocked until 2024-03-01T00:00:00+00:00 due to user specified spend limits."}}
  // {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits."}}
  const isOverQuota =
    error?.message?.match(/usage blocked until/i) ||
    error?.message?.match(/credit balance is too low/i) ||
    error?.message?.match(/You will regain access on/i) ||
    error?.message?.match(/reached your specified API usage limits/i);
  if (isOverQuota) {
    req.log.warn(
      { key: req.key?.hash, message: error?.message },
      "Anthropic key has hit spending limit and will be disabled."
    );
    keyPool.disable(req.key!, "quota");
    await reenqueueRequest(req);
    throw new RetryableError("Claude key hit spending limit, retrying with different key.");
    return;
  }

  const isDisabled =
    error?.message?.match(/organization has been disabled/i) ||
    error?.message?.match(/^operation not allowed/i) ||
    error?.message?.match(/credential is only authorized for use with Claude Code/i);
  if (isDisabled) {
    req.log.warn(
      { key: req.key?.hash, message: error?.message },
      "Anthropic/AWS key has been disabled."
    );
    keyPool.disable(req.key!, "revoked");
    await reenqueueRequest(req);
    throw new RetryableError("Claude key has been disabled, retrying with different key.");
    return;
  }

  errorPayload.proxy_note = `Unrecognized error from the API. (${error?.message})`;
}

async function handleAnthropicRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  if (errorPayload.error?.type === "rate_limit_error") {
    keyPool.markRateLimited(req.key!);
    await reenqueueRequest(req);
    throw new RetryableError("Claude rate-limited request re-enqueued.");
  } else {
    errorPayload.proxy_note = `Unrecognized 429 Too Many Requests error from the API.`;
  }
}

async function handleAwsRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const errorType = errorPayload.error?.type;
  switch (errorType) {
    case "ThrottlingException":
      keyPool.markRateLimited(req.key!);
      await reenqueueRequest(req);
      throw new RetryableError("AWS rate-limited request re-enqueued.");
    case "ModelNotReadyException":
      errorPayload.proxy_note = `The requested model is overloaded. Try again in a few seconds.`;
      break;
    default:
      errorPayload.proxy_note = `Unrecognized rate limit error from AWS. (${errorType})`;
  }
}

async function handleGcpRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  if (errorPayload.error?.type === "RESOURCE_EXHAUSTED") {
    keyPool.markRateLimited(req.key!);
    await reenqueueRequest(req);
    throw new RetryableError("GCP rate-limited request re-enqueued.");
  } else {
    errorPayload.proxy_note = `Unrecognized 429 Too Many Requests error from GCP.`;
  }
}

async function handleDeepseekRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  keyPool.markRateLimited(req.key!);
  await reenqueueRequest(req);
  throw new RetryableError("Deepseek rate-limited request re-enqueued.");
}

async function handleDeepseekBadRequestError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  // Based on the checker code, a 400 response means the key is valid but there was some other error
  errorPayload.proxy_note = `The API rejected the request. Check the error message for details.`;
}

async function handleGlmBadRequestError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  // GLM 400 - Bad Request - similar to DeepSeek handling
  errorPayload.proxy_note = `The GLM API rejected the request. Check the error message for details.`;
}

async function handleGlmRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const error = errorPayload.error || {};
  const message = error.message || errorPayload.message || "";
  
  // Check if it's a quota/billing issue vs rate limiting
  if (message.includes("quota") || message.includes("billing") || message.includes("exceeded your current quota") || message.includes("balance")) {
    // 429 - Quota exceeded - disable key
    req.log.warn(
      { key: req.key?.hash, message },
      "GLM key has exceeded quota and will be disabled"
    );
    keyPool.disable(req.key!, "quota");
    await reenqueueRequest(req);
    throw new RetryableError("GLM key quota exceeded, retrying with different key.");
  } else {
    // 429 - Rate limit reached - temporary, mark as rate limited and retry
    req.log.debug(
      { key: req.key?.hash, message },
      "GLM key rate limited, will retry"
    );
    keyPool.markRateLimited(req.key!);
    await reenqueueRequest(req);
    throw new RetryableError("GLM rate-limited request re-enqueued.");
  }
}

async function handleXaiRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  keyPool.markRateLimited(req.key!);
  await reenqueueRequest(req);
  throw new RetryableError("Xai rate-limited request re-enqueued.");
}

async function handleXaiBadRequestError(
  req: Request, 
  errorPayload: ProxiedErrorPayload
) {
  // Based on the checker code, a 400 response means the key is valid but there was some other error
  errorPayload.proxy_note = `The API rejected the request. Check the error message for details.`;
}

async function handleCohereRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  // Mark the current key as rate limited
  keyPool.markRateLimited(req.key!);
  
  // Store the original request attempt count or initialize it
  req.retryCount = (req.retryCount || 0) + 1;
  
  // Only retry up to 3 times
  if (req.retryCount <= 3) {
    try {
      // Add a small delay before retrying (1-5 seconds)
      const delayMs = 1000 + Math.floor(Math.random() * 4000);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
      // Re-enqueue the request to try with a different key
      await reenqueueRequest(req);
      req.log.info({ attempt: req.retryCount }, "Cohere rate-limited request re-enqueued");
      throw new RetryableError(`Cohere rate-limited request re-enqueued (attempt ${req.retryCount}/3).`);
    } catch (error) {
      if (error instanceof RetryableError) {
        throw error; // Rethrow RetryableError to continue the flow
      }
      req.log.error({ error }, "Failed to re-enqueue rate-limited Cohere request");
    }
  }
  
  // If we've already retried 3 times, show the error to the user
  errorPayload.proxy_note = "Too many requests to the Cohere API. Please try again later.";
}

async function handleMoonshotRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  // Mark the current key as rate limited
  keyPool.markRateLimited(req.key!);
  
  // Store the original request attempt count or initialize it
  req.retryCount = (req.retryCount || 0) + 1;
  
  // Only retry up to 3 times with different keys
  if (req.retryCount <= 3) {
    try {
      // Add a small delay before retrying (2-6 seconds for Moonshot)
      const delayMs = 2000 + Math.floor(Math.random() * 4000);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
      // Re-enqueue the request to try with a different key
      await reenqueueRequest(req);
      req.log.info({ attempt: req.retryCount }, "Moonshot rate-limited request re-enqueued");
      throw new RetryableError(`Moonshot rate-limited request re-enqueued (attempt ${req.retryCount}/3).`);
    } catch (error) {
      if (error instanceof RetryableError) {
        throw error; // Rethrow RetryableError to continue the flow
      }
      req.log.error({ error }, "Failed to re-enqueue rate-limited Moonshot request");
    }
  }
  
  // If we've already retried 3 times, show the error to the user
  errorPayload.proxy_note = "Too many requests to the Moonshot API. Please try again later.";
}

async function handleOpenAIRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
): Promise<Record<string, any>> {
  const type = errorPayload.error?.type;
  switch (type) {
    case "insufficient_quota":
    case "invalid_request_error": // this is the billing_hard_limit_reached error seen in some cases
      // Billing quota exceeded (key is dead, disable it)
      keyPool.disable(req.key!, "quota");
      await reenqueueRequest(req);
      throw new RetryableError("Google AI key quota exceeded, retrying with different key.");
      break;
    case "access_terminated":
      // Account banned (key is dead, disable it)
      keyPool.disable(req.key!, "revoked");
      await reenqueueRequest(req);
      throw new RetryableError("Google AI key banned for policy violations, retrying with different key.");
      break;
    case "billing_not_active":
      // Key valid but account billing is delinquent
      keyPool.disable(req.key!, "quota");
      await reenqueueRequest(req);
      throw new RetryableError("Google AI key billing not active, retrying with different key.");
      break;
    case "requests":
    case "tokens":
      keyPool.markRateLimited(req.key!);
      if (errorPayload.error?.message?.match(/on requests per day/)) {
        // This key has a very low rate limit, so we can't re-enqueue it.
        errorPayload.proxy_note = `Assigned key has reached its per-day request limit for this model. Try another model.`;
        break;
      }

      // Per-minute request or token rate limit is exceeded, which we can retry
      await reenqueueRequest(req);
      throw new RetryableError("Rate-limited request re-enqueued.");
    default:
      errorPayload.proxy_note = `This is likely a temporary error with the API. Try again in a few seconds.`;
      break;
  }
  return errorPayload;
}

async function handleAzureRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const code = errorPayload.error?.code;
  switch (code) {
    case "429":
      keyPool.markRateLimited(req.key!);
      await reenqueueRequest(req);
      throw new RetryableError("Rate-limited request re-enqueued.");
    default:
      errorPayload.proxy_note = `Unrecognized rate limit error from Azure (${code}). Please report this.`;
      break;
  }
}

//{"error":{"code":400,"message":"API Key not found. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com","metadata":{"service":"generativelanguage.googleapis.com"}}]}}
//{"error":{"code":400,"message":"Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.","status":"FAILED_PRECONDITION"}}
async function handleGoogleAIBadRequestError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const error = errorPayload.error || {};
  // google changes this shit every few months
  // i don't want to deal with it
  const keyDeadMsgs = [
    /please enable billing/i,
    /API key not valid/i,
    /API key expired/i,
    /pass a valid API/i,
  ];
  const text = JSON.stringify(error);
  if (keyDeadMsgs.some((msg) => text.match(msg))) {
    req.log.warn(
      { key: req.key?.hash, error: text },
      "Google API key appears to be inoperative."
    );
    keyPool.disable(req.key!, "revoked");
    await reenqueueRequest(req);
    throw new RetryableError("Google API key inoperative, retrying with different key.");
  } else {
    req.log.warn(
      { key: req.key?.hash, error: text },
      "Unknown Google API error."
    );
    errorPayload.proxy_note = `Unrecognized error from Google AI.`;
  }

  // const { message, status, details } = error;
  //
  // if (status === "INVALID_ARGUMENT") {
  //   const reason = details?.[0]?.reason;
  //   if (reason === "API_KEY_INVALID") {
  //     req.log.warn(
  //       { key: req.key?.hash, status, reason, msg: error.message },
  //       "Received `API_KEY_INVALID` error from Google AI. Check the configured API key."
  //     );
  //     keyPool.disable(req.key!, "revoked");
  //     errorPayload.proxy_note = `Assigned API key is invalid.`;
  //   }
  // } else if (status === "FAILED_PRECONDITION") {
  //   if (message.match(/please enable billing/i)) {
  //     req.log.warn(
  //       { key: req.key?.hash, status, msg: error.message },
  //       "Cannot use key due to billing restrictions."
  //     );
  //     keyPool.disable(req.key!, "revoked");
  //     errorPayload.proxy_note = `Assigned API key cannot be used.`;
  //   }
  // } else {
  //   req.log.warn(
  //     { key: req.key?.hash, status, msg: error.message },
  //     "Received unexpected 400 error from Google AI."
  //   );
  // }
}

//{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}
//
async function handleGoogleAIRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const status = errorPayload.error?.status;
  const text = JSON.stringify(errorPayload.error);
  const errorMessage = errorPayload.error?.message?.toLowerCase() || '';

  // sometimes they block keys by rate limiting them to 0 requests per minute
  // for some indefinite period of time
  const keyDeadMsgs = [
    /GenerateContentRequestsPerMinutePerProjectPerRegion/i,
    /"quota_limit_value":"0"/i,
  ];

  // Quota exhaustion indicators in error messages
  const quotaExhaustedMsgs = [
    /quota exceeded/i,
    /free tier|free_tier/i,
    /quota limit/i
  ];

  // If we don't have a key in the request, we can't process rate limits
  if (!req.key) {
    errorPayload.proxy_note = `Rate limit error but no key was found in the request.`;
    return;
  }

  switch (status) {
    case "RESOURCE_EXHAUSTED": {
      // Hard disabled keys - these are completely blocked
      if (keyDeadMsgs.some((msg) => msg.test(text))) {
        req.log.warn(
          { key: req.key.hash, error: text },
          "Google API key appears to be completely disabled and will be removed from rotation."
        );
        keyPool.disable(req.key, "revoked");
        errorPayload.proxy_note = `Assigned API key cannot be used.`;
        return;
      }

      // Check if this is a quota exhaustion error rather than just a rate limit
      const isQuotaExhausted = quotaExhaustedMsgs.some(pattern => pattern.test(text) || pattern.test(errorMessage));
      
      if (isQuotaExhausted && req.body?.model) {
        // Get model family for the current request
        const modelName = req.body.model;
        const isPro = modelName.includes('pro');
        const isFlash = modelName.includes('flash');
        const isUltra = modelName.includes('ultra');
        
        req.log.warn(
          { key: req.key.hash, model: modelName, error: text },
          "Google API key has exhausted its quota for this model family and will be marked as overquota."
        );
        
        // Create a filtered list of model families that excludes the over-quota family
        let familyToRemove: GoogleAIModelFamily | null = null;
        if (isPro) {
          familyToRemove = 'gemini-pro';
          errorPayload.proxy_note = `Assigned API key has exhausted quota for Gemini Pro models.`;
        } else if (isFlash) {
          familyToRemove = 'gemini-flash';
          errorPayload.proxy_note = `Assigned API key has exhausted quota for Gemini Flash models.`;
        } else if (isUltra) {
          familyToRemove = 'gemini-ultra';
          errorPayload.proxy_note = `Assigned API key has exhausted quota for Gemini Ultra models.`;
        } else {
          // If model family can't be determined, just mark as rate limited
          keyPool.markRateLimited(req.key);
          errorPayload.proxy_note = `Assigned API key has exhausted quota but model family couldn't be determined.`;
        }
        
        // Update the modelFamilies in the key if we identified a family to remove
        if (familyToRemove) {
          // Get current model families, filter out the one that's over quota
          const updatedFamilies = [...req.key.modelFamilies].filter(f => f !== familyToRemove);
          
          // Cast the key to GoogleAIKey type to access its specific properties
          const googleKey = req.key as GoogleAIKey;
          
          // Track which families are over quota for future rechecking
          const overQuotaFamilies = googleKey.overQuotaFamilies || [];
          if (!overQuotaFamilies.includes(familyToRemove)) {
            overQuotaFamilies.push(familyToRemove);
          }
          
          // Mark the key as over quota but still usable for other model families
          req.log.info(
            { key: req.key.hash, family: familyToRemove },
            "Marking Google AI key as over quota for specific model family"
          );
          
          // First make a typed update object that includes only the properties we want to update
          interface GoogleAIPartialUpdate {
            modelFamilies: GoogleAIModelFamily[];
            isOverQuota: boolean;
            overQuotaFamilies: GoogleAIModelFamily[];
          }
          
          // Create a properly typed update
          const update: GoogleAIPartialUpdate = { 
            modelFamilies: updatedFamilies as GoogleAIModelFamily[],
            isOverQuota: true,
            overQuotaFamilies
          };
          
          // Use the standard KeyPool interface
          // This gets around the TypeScript issues by letting KeyPool handle routing
          const clonedKey = { ...req.key }; // Make a clone since we'll be modifying it
          keyPool.update(clonedKey, update as any);
        }
        
        // Re-enqueue with a different key
        await reenqueueRequest(req);
        throw new RetryableError("Quota-exhausted request re-enqueued with a different key.");
      }

      // Standard rate limiting - just mark as rate limited temporarily
      req.log.debug({ key: req.key.hash, error: text }, "Google API request rate limited, will retry.");
      keyPool.markRateLimited(req.key);
      await reenqueueRequest(req);
      throw new RetryableError("Rate-limited request re-enqueued.");
    }
    default:
      errorPayload.proxy_note = `Unrecognized rate limit error from Google AI (${status}). Please report this.`;
      break;
  }
}

async function handleQwenBadRequestError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  // Qwen 400 - Bad Request - treat as invalid key
  req.log.warn(
    { key: req.key?.hash, error: errorPayload },
    "Qwen API returned 400 error, marking key as invalid"
  );
  
  // Mark the key as invalid and retry with a different key
  await reenqueueRequest(req);
  throw new RetryableError("Qwen key invalid due to 400 error, retrying with different key.");
}

async function handleQwenRateLimitError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  const error = errorPayload.error || {};
  const message = error.message || errorPayload.message || "";
  
  // Check if it's a quota/billing issue vs rate limiting
  if (message.includes("quota") || message.includes("billing") || message.includes("exceeded your current quota")) {
    // 429 - Quota exceeded - disable key
    req.log.warn(
      { key: req.key?.hash, message },
      "Qwen key has exceeded quota and will be disabled"
    );
    keyPool.disable(req.key!, "quota");
    await reenqueueRequest(req);
    throw new RetryableError("Qwen key quota exceeded, retrying with different key.");
  } else {
    // 429 - Rate limit reached - temporary, mark as rate limited and retry
    req.log.debug(
      { key: req.key?.hash, message },
      "Qwen key rate limited, will retry"
    );
    keyPool.markRateLimited(req.key!);
    await reenqueueRequest(req);
    throw new RetryableError("Qwen rate-limited request re-enqueued.");
  }
}

async function handleQwenServerError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  // Qwen 500 - Server error, retry automatically
  req.retryCount = (req.retryCount || 0) + 1;
  
  if (req.retryCount <= 3) {
    req.log.warn(
      { key: req.key?.hash, attempt: req.retryCount, errorPayload },
      `Qwen server error (500). Re-enqueueing request (attempt ${req.retryCount}/3).`
    );
    
    // Add exponential backoff delay
    const delayMs = Math.min(1000 * Math.pow(2, req.retryCount - 1), 10000);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    
    await reenqueueRequest(req);
    throw new RetryableError(`Qwen server error, retrying (attempt ${req.retryCount}/3).`);
  } else {
    errorPayload.proxy_note = `Qwen server is experiencing issues after 3 retry attempts. Please try again later.`;
  }
}

async function handleQwenServerOverloadError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  // Qwen 503 - Server overloaded, retry with backoff
  req.retryCount = (req.retryCount || 0) + 1;
  
  if (req.retryCount <= 5) {
    req.log.warn(
      { key: req.key?.hash, attempt: req.retryCount, errorPayload },
      `Qwen server overloaded (503). Re-enqueueing request (attempt ${req.retryCount}/5).`
    );
    
    // Longer exponential backoff for server overload
    const delayMs = Math.min(2000 * Math.pow(2, req.retryCount - 1), 30000);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    
    await reenqueueRequest(req);
    throw new RetryableError(`Qwen server overloaded, retrying (attempt ${req.retryCount}/5).`);
  } else {
    errorPayload.proxy_note = `Qwen servers are currently overloaded after 5 retry attempts. Please try again later.`;
  }
}

const incrementUsage: ProxyResHandlerWithBody = async (_proxyRes, req) => {
  if (isTextGenerationRequest(req) || isImageGenerationRequest(req)) {
    const model = req.body.model;
    const tokensUsed = req.promptTokens! + req.outputTokens!;
    req.log.debug(
      {
        model,
        tokensUsed,
        promptTokens: req.promptTokens,
        outputTokens: req.outputTokens,
      },
      `Incrementing usage for model`
    );
    // Get modelFamily for the key usage log
    const modelFamilyForKeyPool = req.modelFamily!; // Should be set by getModelFamilyForRequest earlier
    keyPool.incrementUsage(req.key!, modelFamilyForKeyPool, { input: req.promptTokens!, output: req.outputTokens! });
    if (req.user) {
      incrementPromptCount(req.user.token);
      incrementTokenCount(req.user.token, model, req.outboundApi, { input: req.promptTokens!, output: req.outputTokens! });
    }
  }
};


async function handleOpenRouterError(
  req: Request,
  errorPayload: ProxiedErrorPayload
) {
  // NOTE: OpenRouter's 403 (Key limit exceeded) is handled directly in handleUpstreamErrors
  
  const statusCode = req.key!.service === "openrouter" ? (req.res as any)?.statusCode : undefined;
  const error = errorPayload.error || {};
  const message = error.message || errorPayload.message || "";
  
  // 400 Bad Request
  if (statusCode === 400) {
    if (message.includes("Key limit exceeded")) {
      keyPool.disable(req.key!, "quota");
      await reenqueueRequest(req);
      throw new RetryableError("OpenRouter key limit exceeded (400), retrying with different key.");
    }
    errorPayload.proxy_note = `The OpenRouter API rejected the request. Check the error message for details.`;
  }
  
  // 401 Unauthorized
  if (statusCode === 401) {
    keyPool.disable(req.key!, "revoked");
    await reenqueueRequest(req);
    throw new RetryableError("OpenRouter key authentication failed, retrying with different key.");
  }
  
  // 402 Payment Required
  if (statusCode === 402) {
    keyPool.disable(req.key!, "quota");
    await reenqueueRequest(req);
    throw new RetryableError("OpenRouter key has insufficient balance/credits, retrying with different key.");
  }
  
  // 404 Not Found (e.g., model not found)
  if (statusCode === 404) {
    // Treat as key unable to access model or service (revoked capabilities)
    keyPool.disable(req.key!, "revoked"); 
    await reenqueueRequest(req);
    throw new RetryableError("OpenRouter key does not support the requested model (404), retrying with different key.");
  }
  
  // 429 Too Many Requests
  if (statusCode === 429) {
    keyPool.markRateLimited(req.key!);
    await reenqueueRequest(req);
    throw new RetryableError("OpenRouter rate-limited request re-enqueued.");
  }
}


const countResponseTokens: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  _res,
  body
) => {
  if (req.outboundApi === "openai-image") {
    req.outputTokens = req.promptTokens;
    req.promptTokens = 0;
    return;
  }

  // This function is prone to breaking if the upstream API makes even minor
  // changes to the response format, especially for SSE responses. If you're
  // seeing errors in this function, check the reassembled response body from
  // handleStreamedResponse to see if the upstream API has changed.
  try {
    assertJsonResponse(body);
    const service = req.outboundApi;
    // Try to get token counts from the API response first
    let tokens: { token_count: number; tokenizer: string; reasoning_tokens?: number } | null = null;

    // Anthropic API returns usage data in the response
    if (service === "anthropic-chat" && body.usage) {
      tokens = {
        token_count: body.usage.output_tokens || 0,
        tokenizer: "anthropic-api",
      };
      req.log.debug(
        { service, outputTokens: tokens.token_count, usage: body.usage },
        "Got output token count from Anthropic API response"
      );

      // Sanity check: if request had cache_control, expect cache metrics
      if (req.body.system || req.body.tools || req.body.messages) {
        const hasCacheControl = checkForCacheControl(req.body);
        if (hasCacheControl) {
          const cacheRead = body.usage.cache_read_input_tokens || 0;
          const cacheCreation = body.usage.cache_creation_input_tokens || 0;
          if (cacheRead === 0 && cacheCreation === 0) {
            req.log.error(
              { keyHash: req.key?.hash, usage: body.usage },
              "CACHE SANITY CHECK FAILED: Request had cache_control but received NO cache metrics from Anthropic API"
            );
          }
        }
      }
    }
    // AWS Bedrock returns usage data in the response (same format as Anthropic)
    else if (req.service === "aws" && service === "anthropic-chat" && body.usage) {
      tokens = {
        token_count: body.usage.output_tokens || 0,
        tokenizer: "aws-bedrock-api",
      };
      req.log.debug(
        { service, outputTokens: tokens.token_count, usage: body.usage },
        "Got output token count from AWS Bedrock API response"
      );

      // Sanity check: if request had cache_control, expect cache metrics
      if (req.body.system || req.body.tools || req.body.messages) {
        const hasCacheControl = checkForCacheControl(req.body);
        if (hasCacheControl) {
          const cacheRead = body.usage.cache_read_input_tokens || 0;
          const cacheCreation = body.usage.cache_creation_input_tokens || 0;
          if (cacheRead === 0 && cacheCreation === 0) {
            req.log.error(
              { keyHash: req.key?.hash, usage: body.usage },
              "CACHE SANITY CHECK FAILED: Request had cache_control but received NO cache metrics from AWS Bedrock API"
            );
          }
        }
      }
    }
    // GCP Vertex AI returns usage data in the response
    // For Anthropic models, GCP returns Anthropic format (usage.output_tokens)
    // For Gemini models, GCP returns GCP format (usageMetadata.candidatesTokenCount)
    else if (req.service === "gcp") {
      if (service === "anthropic-chat" && body.usage?.output_tokens) {
        tokens = {
          token_count: body.usage.output_tokens || 0,
          tokenizer: "gcp-anthropic-api",
        };
        req.log.debug(
          { service, outputTokens: tokens.token_count, usage: body.usage },
          "Got output token count from GCP Vertex AI (Anthropic format)"
        );

        // Sanity check: if request had cache_control, expect cache metrics
        if (req.body.system || req.body.tools || req.body.messages) {
          const hasCacheControl = checkForCacheControl(req.body);
          if (hasCacheControl) {
            const cacheRead = body.usage.cache_read_input_tokens || 0;
            const cacheCreation = body.usage.cache_creation_input_tokens || 0;
            if (cacheRead === 0 && cacheCreation === 0) {
              req.log.error(
                { keyHash: req.key?.hash, usage: body.usage },
                "CACHE SANITY CHECK FAILED: Request had cache_control but received NO cache metrics from GCP Vertex AI API"
              );
            }
          }
        }
      } else if (body.usageMetadata) {
        tokens = {
          token_count: body.usageMetadata.candidatesTokenCount || 0,
          tokenizer: "gcp-vertex-api",
        };
        req.log.debug(
          { service, outputTokens: tokens.token_count, usageMetadata: body.usageMetadata },
          "Got output token count from GCP Vertex AI (Gemini format)"
        );
      }
    }
    // OpenAI and similar services return usage data
    else if (body.usage?.completion_tokens) {
      tokens = {
        token_count: body.usage.completion_tokens,
        tokenizer: "api-usage-data",
      };

    
    if (req.service === "openai" || req.service === "azure" || req.service === "deepseek" || req.service === "glm" || req.service === "cohere" || req.service === "qwen") {
      // O1 consumes (a significant amount of) invisible tokens for the chain-
      // of-thought reasoning. We have no way to count these other than to check
      // the response body.
      tokens.reasoning_tokens =
        body.usage?.completion_tokens_details?.reasoning_tokens;
    }
	
	req.log.debug(
      { service, outputTokens: tokens.token_count, usage: body.usage },
      "Got output token count from API usage data"
    );
    }

    // Fall back to local tokenization if no usage data is available
    if (!tokens) {
      const completion = getCompletionFromBody(req, body);
      tokens = await countTokens({ req, completion, service });
      req.log.debug(
        { service, outputTokens: tokens.token_count },
        "Counted output tokens locally (no API usage data)"
      );
    }


    req.log.debug(
      { service, prevOutputTokens: req.outputTokens, tokens },
      `Counted tokens for completion`
    );
    if (req.tokenizerInfo) {
      req.tokenizerInfo.completion_tokens = tokens;
    }

    req.outputTokens = tokens.token_count + (tokens.reasoning_tokens ?? 0);
  } catch (error) {
    req.log.warn(
      error,
      "Error while counting completion tokens; assuming `max_output_tokens`"
    );
    // req.outputTokens will already be set to `max_output_tokens` from the
    // prompt counting middleware, so we don't need to do anything here.
  }
};

const trackKeyRateLimit: ProxyResHandlerWithBody = async (proxyRes, req) => {
  keyPool.updateRateLimits(req.key!, proxyRes.headers);
};

const omittedHeaders = new Set<string>([
  // Omit content-encoding because we will always decode the response body
  "content-encoding",
  // Omit transfer-encoding because we are using response.json which will
  // set a content-length header, which is not valid for chunked responses.
  "transfer-encoding",
  // Don't set cookies from upstream APIs because proxied requests are stateless
  "set-cookie",
  "openai-organization",
  "x-request-id",
  "x-ds-request-id",
  "x-ds-trace-id",
  "cf-ray",
]);
const copyHttpHeaders: ProxyResHandlerWithBody = async (
  proxyRes,
  _req,
  res
) => {
  // Hack: we don't copy headers since with chunked transfer we've already sent them.
  if (_req.isChunkedTransfer) return;

  Object.keys(proxyRes.headers).forEach((key) => {
    if (omittedHeaders.has(key)) return;
    res.setHeader(key, proxyRes.headers[key] as string);
  });
};

/**
 * Injects metadata into the response, such as the tokenizer used, logging
 * status, upstream API endpoint used, and whether the input prompt was modified
 * or transformed.
 * Only used for non-streaming requests.
 */
const injectProxyInfo: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  const { service, inboundApi, outboundApi, tokenizerInfo } = req;
  const native = inboundApi === outboundApi;
  const info: any = {
    logged: config.promptLogging,
    tokens: tokenizerInfo,
    service,
    in_api: inboundApi,
    out_api: outboundApi,
    prompt_transformed: !native,
  };

  if (req.query?.debug?.length) {
    info.final_request_body = req.signedRequest?.body || req.body;
  }

  if (typeof body === "object") {
    body.proxy = info;
  }
};

function getAwsErrorType(header: string | string[] | undefined) {
  const val = String(header).match(/^(\w+):?/)?.[1];
  return val || String(header);
}

function checkForCacheControl(body: any): boolean {
  // Check tools
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool.cache_control) return true;
    }
  }

  // Check system blocks
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block.cache_control) return true;
    }
  }

  // Check message content blocks
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.cache_control) return true;
        }
      }
    }
  }

  return false;
}


function assertJsonResponse(body: any): asserts body is Record<string, any> {
  if (typeof body !== "object") {
    throw new Error(`Expected response to be an object, got ${typeof body}`);
  }
}