// src/proxy/groq.ts

import { Router } from "express";
import { ipLimiter } from "./rate-limit";
import { addKey, createPreprocessorMiddleware, finalizeBody } from "./middleware/request";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";

const groqBaseUrl = "https://api.groq.com/openai/v1";

const groqProxy = createQueuedProxyMiddleware({
  target: groqBaseUrl,
  // Groq uses an OpenAI-compatible API
  mutations: [addKey, finalizeBody],
});

const groqPreprocessor = createPreprocessorMiddleware(
  {
    inApi: "openai",
    outApi: "openai",
    service: "groq"
  },
  {
    afterTransform: []
  }
);

const groqRouter = Router();

// Endpoint for chat completions (OpenAI compatible)
groqRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  groqPreprocessor,
  groqProxy
);

// Endpoint for model listing
groqRouter.get(
  "/v1/models",
  ipLimiter,
  groqProxy
);

export const groq = groqRouter;