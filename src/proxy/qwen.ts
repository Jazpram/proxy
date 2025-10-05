import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware, extractQwenExtraBody } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import axios from "axios";
import { QwenKey, keyPool } from "../shared/key-management";
import {
  isQwenModel,
  isQwenThinkingModel,
  normalizeMessages,
  isQwenCommercialModel,
  isQwenOpenSourceModel,
  isQwenThinkingOnlyModel,
  isQwenOmniModel
} from "../shared/api-schemas/qwen";
import { logger } from "../logger";

const log = logger.child({ module: "proxy", service: "qwen" });
let modelsCache: any = null;
let modelsCacheTime = 0;

const qwenResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  res.status(200).json({ ...body, proxy: body.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  try {
    // Get a Qwen key directly
    const modelToUse = "qwen-plus"; // Use any Qwen model here - just for key selection
    const qwenKey = keyPool.get(modelToUse, "qwen") as QwenKey;
    
    if (!qwenKey || !qwenKey.key) {
      log.warn("No valid Qwen key available for model listing");
      throw new Error("No valid Qwen API key available");
    }

    // Fetch models directly from Qwen API
    const response = await axios.get("https://dashscope.aliyuncs.com/compatible-mode/v1/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${qwenKey.key}`
      },
    });

    if (!response.data || !response.data.data) {
      throw new Error("Unexpected response format from Qwen API");
    }

    // Extract models
    const models = response.data;
    
    // Complete list of Qwen models from documentation
    const knownQwenModels = [
      // Commercial models
      "qwen-max",
      "qwen-max-latest",
      "qwen-max-2025-01-25",
      "qwen-plus",
      "qwen-plus-latest",
      "qwen-plus-2025-04-28",
      "qwen-plus-2025-01-25",
      "qwen-turbo",
      "qwen-turbo-latest",
      "qwen-turbo-2025-04-28",
      "qwen-turbo-2024-11-01",
      "qwen-flash",
      "qwen-flash-latest",
      "qwen-flash-2025-07-28",
      
      // Open-source models - Qwen3 series (hybrid-thinking)
      "qwen3-235b-a22b",
      "qwen3-32b",
      "qwen3-30b-a3b",
      "qwen3-14b",
      "qwen3-8b",
      "qwen3-4b",
      "qwen3-1.7b",
      "qwen3-0.6b",
      
      // Thinking-only models
      "qwen3-next-80b-a3b-thinking",
      "qwen3-235b-a22b-thinking-2507",
      "qwen3-30b-a3b-thinking-2507",
      
      // QwQ models
      "qwq-32b",
      
      // Qwen2.5 series
      "qwen2.5-14b-instruct-1m",
      "qwen2.5-7b-instruct-1m",
      "qwen2.5-72b-instruct",
      "qwen2.5-32b-instruct",
      "qwen2.5-14b-instruct",
      "qwen2.5-7b-instruct",
      
      // Qwen2 series
      "qwen2-72b-instruct",
      "qwen2-7b-instruct",
      
      // Qwen1.5 series
      "qwen1.5-110b-chat",
      "qwen1.5-72b-chat",
      "qwen1.5-32b-chat",
      "qwen1.5-14b-chat",
      "qwen1.5-7b-chat",
      
      // Qwen-Coder series
      "qwen3-coder-plus",
      "qwen3-coder-flash",
      "qwen3-coder-480b-a35b-instruct",
      "qwen3-coder-30b-a3b-instruct"
    ];
    
    // Add thinking capability flag to models that support it
    if (models.data && Array.isArray(models.data)) {
      // Create a set of existing model IDs for quick lookup
      const existingModelIds = new Set(models.data.map((model: any) => model.id));
      
      // Add any missing models from our known list
      knownQwenModels.forEach(modelId => {
        if (!existingModelIds.has(modelId)) {
          models.data.push({
            id: modelId,
            object: "model",
            created: Date.now(),
            owned_by: "qwen",
            capabilities: isQwenThinkingModel(modelId) ? { thinking: true } : {}
          });
        }
      });
      
      // Add thinking capability flag to existing models
      models.data.forEach((model: any) => {
        if (isQwenThinkingModel(model.id)) {
          model.capabilities = model.capabilities || {};
          model.capabilities.thinking = true;
        }
      });
    } else {
      // If the API response didn't include models, create our own list
      models.data = knownQwenModels.map(modelId => ({
        id: modelId,
        object: "model",
        created: Date.now(),
        owned_by: "qwen",
        capabilities: isQwenThinkingModel(modelId) ? { thinking: true } : {}
      }));
    }

    log.debug({ modelCount: models.data?.length }, "Retrieved models from Qwen API");

    // Cache the response
    modelsCache = models;
    modelsCacheTime = new Date().getTime();
    return models;
  } catch (error) {
    // Provide detailed logging for better troubleshooting
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error fetching Qwen models"
      );
    } else {
      log.error({ error }, "Unknown error fetching Qwen models");
    }
    
    // Return empty list as fallback
    return {
      object: "list",
      data: [],
    };
  }
};

const handleModelRequest: RequestHandler = async (_req, res) => {
  try {
    const models = await getModelsResponse();
    res.status(200).json(models);
  } catch (error) {
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error handling model request"
      );
    } else {
      log.error({ error }, "Unknown error handling model request");
    }
    res.status(500).json({ error: "Failed to fetch models" });
  }
};

// Function to prepare messages for Qwen API
function prepareMessages(req: Request) {
  if (req.body.messages && Array.isArray(req.body.messages)) {
    req.body.messages = normalizeMessages(req.body.messages);
  }
}

// Function to enable partial mode for Qwen models (same as DeepSeek prefill)
function enablePartialMode(req: Request) {
  // If you want to disable partial mode
  if (process.env.NO_QWEN_PARTIAL) return;
  
  const model = req.body.model;
  
  // Disable partial mode if thinking is enabled or for thinking-only models
  if (req.body.enable_thinking === true || isQwenThinkingOnlyModel(model)) {
    log.debug(
      { model: model, enableThinking: req.body.enable_thinking, isThinkingOnly: isQwenThinkingOnlyModel(model) },
      "Skipped partial mode due to thinking capability"
    );
    return;
  }
  
  const msgs = req.body.messages;
  if (msgs.at(-1)?.role !== 'assistant') return;

  let i = msgs.length - 1;
  let content = '';
  
  while (i >= 0 && msgs[i].role === 'assistant') {
    // Concatenate consecutive assistant messages
    content = msgs[i--].content + content;
  }
  
  // Replace consecutive assistant messages with single message with partial: true
  msgs.splice(i + 1, msgs.length, { role: 'assistant', content, partial: true });
  log.debug("Consolidated assistant messages and enabled partial mode for Qwen request");
}

// Function to handle thinking capability for Qwen models
function handleThinkingCapability(req: Request) {
  const model = req.body.model;
  
  // Handle thinking-only models (always think, except if explicitly disabled by /no_think)
  if (isQwenThinkingOnlyModel(model)) {
    // Check for /no_think commands even on thinking-only models
    const thinkCommandResult = detectThinkCommand(req);
    if (thinkCommandResult === false) {
      // /no_think command found - disable thinking even for thinking-only models
      req.body.enable_thinking = false;
      log.debug(
        { model: model, enableThinking: false },
        "Disabled thinking due to /no_think command (overriding thinking-only model)"
      );
    } else {
      req.body.enable_thinking = true;
      log.debug(
        { model: model, enableThinking: true },
        "Applied thinking-only mode for model"
      );
    }
    return;
  }
  
  // Auto-detect thinking commands in conversation history (this takes precedence)
  const thinkCommandResult = detectThinkCommand(req);
  if (thinkCommandResult !== null) {
    const previousSetting = req.body.enable_thinking;
    req.body.enable_thinking = thinkCommandResult;
    log.debug(
      { model: model, previousSetting, newSetting: thinkCommandResult },
      thinkCommandResult ? "Auto-enabled thinking due to /think command in conversation" : "Auto-disabled thinking due to /no_think command in conversation"
    );
    
    // If thinking_budget is provided but we're disabling thinking, remove it
    if (!thinkCommandResult && req.body.thinking_budget !== undefined) {
      delete req.body.thinking_budget;
      log.debug({ model: model }, "Removed thinking_budget due to /no_think command");
    }
    return;
  }
  
  // If enable_thinking is explicitly set, preserve it (unless overridden by commands above)
  if (req.body.enable_thinking === true) {
    if (!isQwenThinkingModel(model)) {
      req.log.warn(
        { model: model },
        "enable_thinking=true requested for non-thinking model, keeping as requested"
      );
    } else {
      log.debug(
        { model: model, enableThinking: true },
        "Preserving explicitly set enable_thinking=true"
      );
    }
    return;
  }
  
  if (req.body.enable_thinking === false) {
    log.debug(
      { model: model, enableThinking: false },
      "Preserving explicitly set enable_thinking=false"
    );
    return;
  }
  
  // Apply correct defaults based on model type (only if not explicitly set)
  if (req.body.enable_thinking === undefined && isQwenThinkingModel(model)) {
    if (isQwenCommercialModel(model)) {
      // Commercial models default to false
      req.body.enable_thinking = false;
    } else if (isQwenOpenSourceModel(model)) {
      // Open-source models default to true
      req.body.enable_thinking = true;
    }
    
    log.debug(
      { model: model, isCommercial: isQwenCommercialModel(model), isOpenSource: isQwenOpenSourceModel(model), enableThinking: req.body.enable_thinking },
      "Applied default thinking mode for model"
    );
  }
  
  // If thinking_budget is provided but enable_thinking is false, enable thinking
  if (req.body.thinking_budget !== undefined && req.body.enable_thinking === false) {
    req.body.enable_thinking = true;
    log.debug(
      { model: model, thinking_budget: req.body.thinking_budget },
      "Enabled thinking due to thinking_budget parameter"
    );
  }
}

// Function to detect /think commands in message content
function detectThinkCommand(req: Request): boolean | null {
  if (!req.body.messages || !Array.isArray(req.body.messages)) {
    return false;
  }
  
  // Scan all messages in chronological order to find the most recent thinking command
  let latestThinkingState: boolean | null = null;
  let latestCommandMessage = '';
  
  for (let i = 0; i < req.body.messages.length; i++) {
    const message = req.body.messages[i];
    if (message.role === 'user' && typeof message.content === 'string') {
      const content = message.content;
      
      // Look for /think command patterns (enable thinking)
      const thinkPatterns = [
        /\/think\b/i,          // /think
        /\\think\b/i,          // \think (escaped)
      ];
      
      // Look for /no_think command patterns (disable thinking)
      const noThinkPatterns = [
        /\/no[_-]?think\b/i,    // /no_think, /no-think, /nothink
        /\\no[_-]?think\b/i,    // \no_think, \no-think, \nothink
      ];
      
      const hasThinkCommand = thinkPatterns.some(pattern => pattern.test(content));
      const hasNoThinkCommand = noThinkPatterns.some(pattern => pattern.test(content));
      
      if (hasThinkCommand) {
        latestThinkingState = true;
        latestCommandMessage = content.substring(0, 100);
      } else if (hasNoThinkCommand) {
        latestThinkingState = false;
        latestCommandMessage = content.substring(0, 100);
      }
    }
  }
  
  if (latestThinkingState !== null) {
    log.debug(
      {
        thinkingEnabled: latestThinkingState,
        commandMessage: latestCommandMessage,
        totalMessages: req.body.messages.length
      },
      "Detected thinking command state from conversation history"
    );
    return latestThinkingState;
  }
  
  return null;
}

// Function to validate and handle parameters for Qwen models
function validateAndHandleParameters(req: Request) {
  const model = req.body.model;
  
  // Handle logprobs parameters - these are supported for certain models
  if (req.body.logprobs === true && !req.body.top_logprobs) {
    req.body.top_logprobs = 0; // Default value when logprobs is enabled
  }
  
  // Validate max_input_tokens for specific models
  if (req.body.max_input_tokens !== undefined) {
    if (model === "qwen-plus-latest" && req.body.max_input_tokens > 129024) {
      req.body.max_input_tokens = 129024;
      log.debug({ model, max_input_tokens: 129024 }, "Capped max_input_tokens for model");
    } else if (model === "qwen-plus-2025-07-28" && req.body.max_input_tokens > 1000000) {
      req.body.max_input_tokens = 1000000;
      log.debug({ model, max_input_tokens: 1000000 }, "Capped max_input_tokens for model");
    }
  }
  
  // Handle n parameter - only supported for certain models
  if (req.body.n !== undefined && req.body.n > 1) {
    if (!model.includes("qwen-plus") && !model.includes("qwen3")) {
      req.body.n = 1;
      log.debug({ model }, "Capped n parameter to 1 for unsupported model");
    }
    
    // When tools are used, n must be 1
    if (req.body.tools && req.body.tools.length > 0) {
      req.body.n = 1;
      log.debug({ model }, "Set n=1 due to tools usage");
    }
  }
  
  // Handle modalities parameter for Qwen-Omni models
  if (req.body.modalities && !isQwenOmniModel(model)) {
    delete req.body.modalities;
    delete req.body.audio;
    log.debug({ model }, "Removed modalities parameters for non-Omni model");
  }
  
  // Handle translation_options validation
  if (req.body.translation_options) {
    if (!model.includes("translation")) {
      // Keep translation options but log a warning
      log.debug({ model }, "Translation options provided for non-translation model");
    }
  }
  
  // Remove truly unsupported parameters (if any)
  if (req.body.logit_bias !== undefined) {
    delete req.body.logit_bias;
    log.debug({ model }, "Removed unsupported logit_bias parameter");
  }
  
  // Logging for debugging
  if (process.env.NODE_ENV !== 'production') {
    log.debug({ body: req.body }, "Request after parameter validation");
  }
}

// Set up count token functionality for Qwen models
function countQwenTokens(req: Request) {
  const model = req.body.model;
  
  if (isQwenModel(model)) {
    // Count tokens using prompt tokens (simplified)
    if (req.promptTokens) {
      req.log.debug(
        { tokens: req.promptTokens },
        "Estimated token count for Qwen prompt"
      );
    }
  }
}

const qwenProxy = createQueuedProxyMiddleware({
  mutations: [
    addKey,
    finalizeBody
  ],
  target: "https://dashscope.aliyuncs.com/compatible-mode",
  blockingResponseHandler: qwenResponseHandler,
});

const qwenRouter = Router();

qwenRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "qwen" },
    { afterTransform: [ extractQwenExtraBody, prepareMessages, handleThinkingCapability, enablePartialMode, validateAndHandleParameters, countQwenTokens ] }
  ),
  qwenProxy
);

qwenRouter.post(
  "/v1/embeddings",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "qwen" },
    { afterTransform: [] }
  ),
  qwenProxy
);

qwenRouter.get("/v1/models", handleModelRequest);

export const qwen = qwenRouter;
