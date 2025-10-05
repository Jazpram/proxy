// src/proxy/openrouter.ts

import { Router } from "express";
import { ipLimiter } from "./rate-limit";
import { addKey, createPreprocessorMiddleware, finalizeBody } from "./middleware/request";
import { createQueuedProxyMiddleware } from "./middleware/request/proxy-middleware-factory";
import { ProxyReqManager } from "./middleware/request/proxy-req-manager";

const openRouterBaseUrl = "https://openrouter.ai/api/v1";

function selectUpstreamPath(manager: ProxyReqManager) {
  const req = manager.request;
  const pathname = req.url.split("?")[0];
  
  // ИСПРАВЛЕНИЕ: Проверяем и удаляем /v1 префикс, если он есть,
  // так как OpenRouter не ожидает его в своем прокси-роуте.
  let newPathname = pathname;

  if (newPathname.startsWith("/v1/")) {
    // Если клиент отправил /v1/chat/completions, он становится /chat/completions
    newPathname = newPathname.substring(3);
  } else if (newPathname.startsWith("/v1")) {
    // Если клиент отправил /v1models, он становится /models
    newPathname = newPathname.substring(2);
  }

  // Обновляем путь, сохраняя query parameters
  manager.setPath(newPathname + req.url.substring(pathname.length));
}

const openRouterProxy = createQueuedProxyMiddleware({
  target: openRouterBaseUrl,
  // OpenRouter uses an OpenAI-compatible API for chat completions
  mutations: [selectUpstreamPath, addKey, finalizeBody],
});

const openRouterPreprocessor = createPreprocessorMiddleware(
  {
    inApi: "openai", 
    outApi: "openai", 
    service: "openrouter" 
  },
  { 
    afterTransform: [] 
  }
);

const openrouterRouter = Router();

// Endpoint for chat completions (OpenAI compatible)
// Ожидаемые пути: /v1/chat/completions или /chat/completions
openrouterRouter.post(
  "/v1/chat/completions",
  ipLimiter,
  openRouterPreprocessor,
  openRouterProxy
);
openrouterRouter.post(
  "/chat/completions",
  ipLimiter,
  openRouterPreprocessor,
  openRouterProxy
);

// Endpoint for model listing
// Ожидаемые пути: /v1/models или /models
openrouterRouter.get(
    "/v1/models",
    ipLimiter,
    openRouterProxy
);
openrouterRouter.get(
    "/models",
    ipLimiter,
    openRouterProxy
);


export const openrouter = openrouterRouter;