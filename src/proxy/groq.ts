import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { GroqKey, keyPool } from "../shared/key-management";
import {
  isGroqVisionModel,
  isGroqToolModel,
  isGroqJsonModel,
  contentToString
} from "../shared/api-schemas/groq";

let modelsCache: any = null;
let modelsCacheTime = 0;

const groqResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  // For Groq, we generally pass through the response as-is
  // since Groq already follows OpenAI-compatible format
  // But we may need to handle some special cases

  let newBody = body;

  // Check if this is a chat completion response with choices
  if (body.choices && Array.isArray(body.choices) && body.choices.length > 0) {
    // Groq-specific response handling can be added here
    // For now, we pass through the response unchanged
    req.log.debug("Groq chat completion response received");
  }

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 5 minutes old (Groq models list is stable)
  if (new Date().getTime() - modelsCacheTime < 1000 * 60 * 5) {
    return modelsCache;
  }

  try {
    // Get a Groq key directly using keyPool.get()
    const modelToUse = "llama-3.1-8b-instant"; // Use any Groq model here - just for key selection
    const groqKey = keyPool.get(modelToUse, "groq") as GroqKey;

    if (!groqKey || !groqKey.key) {
      throw new Error("Failed to get valid Groq key");
    }

    // Fetch models from Groq API with authorization
    const response = await axios.get("https://api.groq.com/openai/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey.key}`
      },
    });

    // If successful, update the cache
    if (response.data && response.data.data) {
      modelsCache = {
        object: "list",
        data: response.data.data.map((model: any) => ({
          id: model.id,
          object: "model",
          owned_by: "groq",
          created: model.created || new Date().getTime(),
        })),
      };
    } else {
      throw new Error("Unexpected response format from Groq API");
    }
  } catch (error) {
    console.error("Error fetching Groq models:", error);
    throw error; // No fallback - error will be passed to caller
  }

  modelsCacheTime = new Date().getTime();
  return modelsCache;
};

const handleModelRequest: RequestHandler = async (_req, res) => {
  try {
    const modelsResponse = await getModelsResponse();
    res.status(200).json(modelsResponse);
  } catch (error) {
    console.error("Error in handleModelRequest:", error);
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

const groqProxy = createQueuedProxyMiddleware({
  mutations: [addKey, finalizeBody],
  target: "https://api.groq.com/openai",
  blockingResponseHandler: groqResponseHandler,
});

const groqRouter = Router();

// Function to remove parameters not supported by Groq models and handle special cases
function removeUnsupportedParameters(req: Request) {
  const model = req.body.model;

  // Groq has specific parameter limitations
  // Remove unsupported parameters based on model type

  if (isGroqVisionModel(model)) {
    req.log.debug(`Detected Groq vision model: ${model}`);

    // Ensure messages have proper format for vision models
    if (req.body.messages && Array.isArray(req.body.messages)) {
      req.body.messages.forEach((msg: { content: string | any[] }) => {
        // If content is a string but the model is vision-capable,
        // convert it to an array with a single text item for consistency
        if (typeof msg.content === 'string') {
          req.log.debug('Converting string content to array format for vision model');
          msg.content = [{ type: 'text', text: msg.content }];
        }
      });
    }
  }

  // Handle JSON mode - only supported by certain models
  if (req.body.response_format?.type === 'json_object' && !isGroqJsonModel(model)) {
    req.log.warn(`JSON mode requested but not supported by model ${model}, removing response_format`);
    delete req.body.response_format;
  }

  // Handle tool use - only supported by certain models
  if (req.body.tools && !isGroqToolModel(model)) {
    req.log.warn(`Tools requested but not supported by model ${model}, removing tools and tool_choice`);
    delete req.body.tools;
    delete req.body.tool_choice;
  }

  // Groq-specific parameter constraints
  if (req.body.top_logprobs !== undefined) {
    // Groq supports top_logprobs up to 5
    if (req.body.top_logprobs > 5) {
      req.log.debug(`Clamping top_logprobs from ${req.body.top_logprobs} to 5 for Groq`);
      req.body.top_logprobs = 5;
    }
  }

  // Groq has specific limits for max_tokens
  if (req.body.max_tokens && req.body.max_tokens > 8192) {
    req.log.debug(`Clamping max_tokens from ${req.body.max_tokens} to 8192 for Groq`);
    req.body.max_tokens = 8192;
  }

  if (req.body.max_completion_tokens && req.body.max_completion_tokens > 8192) {
    req.log.debug(`Clamping max_completion_tokens from ${req.body.max_completion_tokens} to 8192 for Groq`);
    req.body.max_completion_tokens = 8192;
  }
}

// Set up count token functionality for Groq models
function countGroqTokens(req: Request) {
  const model = req.body.model;

  // For vision models, estimate image token usage
  if (isGroqVisionModel(model) && req.body.messages && Array.isArray(req.body.messages)) {
    // Initialize image count
    let imageCount = 0;

    // Count images in the request
    for (const msg of req.body.messages) {
      if (Array.isArray(msg.content)) {
        const imagesInMessage = msg.content.filter(
          (item: any) => item.type === "image_url"
        ).length;
        imageCount += imagesInMessage;
      }
    }

    // Apply token estimations for images
    // Groq's vision models have specific token costs for images
    const TOKENS_PER_IMAGE = 1440; // Approximate token cost for Groq vision models

    if (imageCount > 0) {
      const imageTokens = imageCount * TOKENS_PER_IMAGE;
      req.log.debug(
        { imageCount, tokenEstimate: imageTokens },
        "Estimated token count for Groq vision images"
      );

      // Add the image tokens to the existing token count if available
      if (req.promptTokens) {
        req.promptTokens += imageTokens;
      }
    }
  }
}

groqRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "groq" },
    { afterTransform: [ removeUnsupportedParameters, countGroqTokens ] }
  ),
  groqProxy
);

// Groq also supports completions endpoint (for compatibility)
groqRouter.post(
  "/v1/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai-text", outApi: "openai-text", service: "groq" },
    { afterTransform: [ removeUnsupportedParameters, countGroqTokens ] }
  ),
  groqProxy
);

groqRouter.get("/v1/models", handleModelRequest);

export { groqRouter as groq };