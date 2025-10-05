import { Request, RequestHandler, Router } from "express";
import { createPreprocessorMiddleware } from "./middleware/request";
import { ipLimiter } from "./rate-limit";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { addKey, finalizeBody } from "./middleware/request";
import { ProxyResHandlerWithBody } from "./middleware/response";
import { ProxyReqMutator } from "./middleware/request";
import axios from "axios";
import { GlmKey, keyPool } from "../shared/key-management";
import { isGlmModel, isGlmThinkingModel, isGlmVisionModel } from "../shared/api-schemas/glm";
import { logger } from "../logger";

const log = logger.child({ module: "proxy", service: "glm" });
let modelsCache: any = null;
let modelsCacheTime = 0;

const glmResponseHandler: ProxyResHandlerWithBody = async (
  _proxyRes,
  req,
  res,
  body
) => {
  if (typeof body !== "object") {
    throw new Error("Expected body to be an object");
  }

  let newBody = body;

  res.status(200).json({ ...newBody, proxy: body.proxy });
};

const getModelsResponse = async () => {
  // Return cache if less than 1 minute old
  if (new Date().getTime() - modelsCacheTime < 1000 * 60) {
    return modelsCache;
  }

  try {
    // Get a GLM key directly using keyPool.get()
    const modelToUse = "glm-4.5"; // Use any GLM model here - just for key selection
    const glmKey = keyPool.get(modelToUse, "glm") as GlmKey;
    
    if (!glmKey || !glmKey.key) {
      log.warn("No valid GLM key available for model listing");
      throw new Error("No valid GLM API key available");
    }

    // Fetch models from GLM API with authorization
    const response = await axios.get("https://open.bigmodel.cn/api/paas/v4/models", {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${glmKey.key}`
      },
    });

    if (!response.data || !response.data.data) {
      throw new Error("Unexpected response format from GLM API");
    }

    // Extract models
    const models = response.data;
    
    // Known GLM models from documentation
    const knownGlmModels = [
      "glm-4.5",
      "glm-4.5-air",
      "glm-4.5-x",
      "glm-4.5-airx",
      "glm-4.5-flash",
      "glm-4-plus",
      "glm-4-air-250414",
      "glm-4-airx",
      "glm-4-flashx",
      "glm-4-flashx-250414",
      "glm-z1-air",
      "glm-z1-airx",
      "glm-z1-flash",
      "glm-z1-flashx",
      "glm-4v", // Vision model
    ];
    
    // Add any missing models from our known list
    if (models.data && Array.isArray(models.data)) {
      // Create a set of existing model IDs for quick lookup
      const existingModelIds = new Set(models.data.map((model: any) => model.id));
      
      // Add any missing models from our known list
      knownGlmModels.forEach(modelId => {
        if (!existingModelIds.has(modelId)) {
          models.data.push({
            id: modelId,
            object: "model",
            created: Date.now(),
            owned_by: "glm",
          });
        }
      });
    } else {
      // If the API response didn't include models, create our own list
      models.data = knownGlmModels.map(modelId => ({
        id: modelId,
        object: "model",
        created: Date.now(),
        owned_by: "glm",
      }));
    }

    log.debug({ modelCount: models.data?.length }, "Retrieved models from GLM API");

    // Cache the response
    modelsCache = models;
    modelsCacheTime = new Date().getTime();
    return models;
  } catch (error) {
    // Provide detailed logging for better troubleshooting
    if (error instanceof Error) {
      log.error(
        { errorMessage: error.message, stack: error.stack },
        "Error fetching GLM models"
      );
    } else {
      log.error({ error }, "Unknown error fetching GLM models");
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

// Function to handle GLM-specific request processing
function processGlmRequest(req: Request) {
  const model = req.body.model;
  
  // Validate that this is actually a GLM model
  if (!isGlmModel(model)) {
    log.warn({ model }, "Non-GLM model passed to GLM processor");
    return;
  }
  
  // Handle GLM-specific parameters
  if (req.body.thinking && typeof req.body.thinking === "object") {
    // GLM supports thinking mode for certain models
    if (isGlmThinkingModel(model)) {
      log.debug({ model, thinking: req.body.thinking }, "GLM thinking mode enabled");
    } else {
      delete req.body.thinking;
      log.debug({ model }, "Removed thinking parameter for non-thinking model");
    }
  }
  
  // Validate and handle other GLM-specific parameters
  if (req.body.tools && req.body.tools.length > 0) {
    log.debug({ model, toolCount: req.body.tools.length }, "GLM function calling enabled");
  }
  
  // Handle multimodal requests for GLM-4V
  if (isGlmVisionModel(model) && req.body.messages) {
    const hasImages = req.body.messages.some((msg: any) => 
      msg.content && Array.isArray(msg.content) && 
      msg.content.some((content: any) => content.type === "image_url")
    );
    if (hasImages) {
      log.debug({ model }, "GLM vision model request detected");
    }
  }
  
  // Remove any unsupported parameters
  if (req.body.logit_bias !== undefined) {
    delete req.body.logit_bias;
    log.debug({ model }, "Removed unsupported logit_bias parameter");
  }
  
  // Validate temperature and top_p ranges for GLM
  if (req.body.temperature !== undefined) {
    if (req.body.temperature < 0 || req.body.temperature > 1) {
      req.body.temperature = Math.max(0, Math.min(1, req.body.temperature));
      log.debug({ model }, "Clamped temperature to valid range [0,1]");
    }
  }
  
  if (req.body.top_p !== undefined) {
    if (req.body.top_p < 0 || req.body.top_p > 1) {
      req.body.top_p = Math.max(0, Math.min(1, req.body.top_p));
      log.debug({ model }, "Clamped top_p to valid range [0,1]");
    }
  }
}

// Custom mutator to rewrite path for GLM v4 API
const rewritePathForGlm: ProxyReqMutator = (manager) => {
  const req = manager.request;
  let newPath = req.path;
  
  log.debug({ currentPath: req.path, currentUrl: req.url }, "GLM path before rewrite");
  
  // Always ensure we're targeting the v4 API
  if (req.path === "/chat/completions") {
    newPath = "/v4/chat/completions";
  } else if (req.path === "/models") {
    newPath = "/v4/models";
  } else if (req.path.startsWith("/v1/")) {
    newPath = req.path.replace("/v1/", "/v4/");
  } else if (!req.path.startsWith("/v4/")) {
    newPath = `/v4${req.path}`;
  }
  
  if (newPath !== req.path) {
    manager.setPath(newPath);
    log.debug({ originalPath: req.path, newPath }, "Rewrote GLM path for v4 API");
  }
};

const glmProxy = createQueuedProxyMiddleware({
  mutations: [addKey, rewritePathForGlm, finalizeBody],
  target: "https://open.bigmodel.cn/api/paas",
  blockingResponseHandler: glmResponseHandler,
});

const glmRouter = Router();

// Handle both v1 and direct paths
glmRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "glm" },
    { afterTransform: [processGlmRequest] }
  ),
  glmProxy
);

glmRouter.post(
  "/chat/completions",
  ipLimiter,
  createPreprocessorMiddleware(
    { inApi: "openai", outApi: "openai", service: "glm" },
    { afterTransform: [processGlmRequest] }
  ),
  glmProxy
);

glmRouter.get("/v1/models", handleModelRequest);
glmRouter.get("/models", handleModelRequest);

export const glm = glmRouter;