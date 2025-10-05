import { Request } from "express";
import { RequestPreprocessor } from "../index";

/**
 * Extracts Qwen-specific parameters from `extra_body` and merges them into the main request body.
 * This enables compatibility with OpenAI SDK users who pass Qwen parameters via `extra_body`.
 * 
 * For example:
 * ```
 * {
 *   "model": "qwen-plus",
 *   "messages": [...],
 *   "extra_body": {
 *     "enable_thinking": true,
 *     "thinking_budget": 10000
 *   }
 * }
 * ```
 * 
 * Becomes:
 * ```
 * {
 *   "model": "qwen-plus", 
 *   "messages": [...],
 *   "enable_thinking": true,
 *   "thinking_budget": 10000
 * }
 * ```
 */
export const extractQwenExtraBody: RequestPreprocessor = async (req: Request) => {
  // Only process requests for Qwen service
  if (req.service !== "qwen") {
    return;
  }

  // Check if extra_body exists and is an object
  if (!req.body.extra_body || typeof req.body.extra_body !== "object") {
    return;
  }

  const extraBody = req.body.extra_body;
  let extractedParams: string[] = [];

  // Define Qwen-specific parameters that can be extracted from extra_body
  const qwenParameters = [
    "enable_thinking",
    "thinking_budget",
    "modalities",
    "audio",
    "translation_options",
  ] as const;

  // Extract Qwen-specific parameters from extra_body
  for (const param of qwenParameters) {
    if (param in extraBody) {
      // Always merge parameters from extra_body, but log if there's a conflict
      if (param in req.body) {
        req.log.debug(
          { param, mainValue: req.body[param], extraValue: extraBody[param] },
          "Parameter exists in both main body and extra_body, prioritizing extra_body value"
        );
      }
      req.body[param] = extraBody[param];
      extractedParams.push(param);
    }
  }

  // Remove extra_body to avoid passing it to the API
  delete req.body.extra_body;

  // Log the extraction for debugging
  if (extractedParams.length > 0) {
    req.log.info(
      { 
        extractedParams,
        model: req.body.model 
      },
      "Extracted Qwen parameters from extra_body"
    );
  }
};