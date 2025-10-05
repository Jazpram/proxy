/*  ──────────────────────────────────────────────────────────────
    Login-gated info page
    drop-in replacement for src/info-page.ts
    ──────────────────────────────────────────────────────────── */

import fs from "fs";
import express, { Router, Request, Response } from "express";
import showdown from "showdown";
import { config } from "./config";
import { buildInfo, ServiceInfo } from "./service-info";
import { getLastNImages } from "./shared/file-storage/image-history";
import { keyPool } from "./shared/key-management";
import { MODEL_FAMILY_SERVICE, ModelFamily } from "./shared/models";
import { withSession } from "./shared/with-session";
import { injectCsrfToken, checkCsrfToken } from "./shared/inject-csrf";
import { getUser } from "./shared/users/user-store";

/* ────────────────  TYPES: extend express-session  ──────────── */
declare module "express-session" {
  interface Session {
    infoPageAuthed?: boolean;
  }
}

/* ────────────────  misc constants  ─────────────────────────── */
const INFO_PAGE_TTL = 2_000; // ms
const LOGIN_ROUTE   = "/";

const MODEL_FAMILY_FRIENDLY_NAME: { [f in ModelFamily]: string } = {
  qwen: "Qwen",
  glm: "GLM",
  cohere: "Cohere",
  deepseek: "Deepseek",
  xai: "Grok",
  moonshot: "Moonshot",
  turbo: "GPT-4o Mini / 3.5 Turbo",
  gpt4: "GPT-4",
  "gpt4-32k": "GPT-4 32k",
  "gpt4-turbo": "GPT-4 Turbo",
  gpt4o: "GPT-4o",
  gpt41: "GPT-4.1",
  "gpt41-mini": "GPT-4.1 Mini",
  "gpt41-nano": "GPT-4.1 Nano",
  gpt5: "GPT-5",
  "gpt5-mini": "GPT-5 Mini",
  "gpt5-nano": "GPT-5 Nano",
  "gpt5-chat-latest": "GPT-5 Chat Latest",
  gpt45: "GPT-4.5",
  o1: "OpenAI o1",
  "o1-mini": "OpenAI o1 mini",
  "o1-pro": "OpenAI o1 pro",
  "o3-pro": "OpenAI o3 pro",
  "o3-mini": "OpenAI o3 mini",
  "o3": "OpenAI o3",
  "o4-mini": "OpenAI o4 mini",
  "codex-mini": "OpenAI Codex Mini",
  "dall-e": "DALL-E",
  "gpt-image": "GPT Image",
  claude: "Claude (Sonnet)",
  "claude-opus": "Claude (Opus)",
  "gemini-flash": "Gemini Flash",
  "gemini-pro": "Gemini Pro",
  "gemini-ultra": "Gemini Ultra",
  "mistral-tiny": "Mistral 7B",
  "mistral-small": "Mistral Nemo",
  "mistral-medium": "Mistral Medium",
  "mistral-large": "Mistral Large",
  "aws-claude": "AWS Claude (Sonnet)",
  "aws-claude-opus": "AWS Claude (Opus)",
  "aws-mistral-tiny": "AWS Mistral 7B",
  "aws-mistral-small": "AWS Mistral Nemo",
  "aws-mistral-medium": "AWS Mistral Medium",
  "aws-mistral-large": "AWS Mistral Large",
  "gcp-claude": "GCP Claude (Sonnet)",
  "gcp-claude-opus": "GCP Claude (Opus)",
  "azure-turbo": "Azure GPT-3.5 Turbo",
  "azure-gpt4": "Azure GPT-4",
  "azure-gpt4-32k": "Azure GPT-4 32k",
  "azure-gpt4-turbo": "Azure GPT-4 Turbo",
  "azure-gpt4o": "Azure GPT-4o",
  "azure-gpt45": "Azure GPT-4.5",
  "azure-gpt41": "Azure GPT-4.1",
  "azure-gpt41-mini": "Azure GPT-4.1 Mini",
  "azure-gpt41-nano": "Azure GPT-4.1 Nano",
  "azure-gpt5": "Azure GPT-5",
  "azure-gpt5-mini": "Azure GPT-5 Mini",
  "azure-gpt5-nano": "Azure GPT-5 Nano",
  "azure-gpt5-chat-latest": "Azure GPT-5 Chat Latest",
  "azure-o1": "Azure o1",
  "azure-o1-mini": "Azure o1 mini",
  "azure-o1-pro": "Azure o1 pro",
  "azure-o3-pro": "Azure o3 pro",
  "azure-o3-mini": "Azure o3 mini",
  "azure-o3": "Azure o3",
  "azure-o4-mini": "Azure o4 mini",
  "azure-codex-mini": "Azure Codex Mini",
  "azure-dall-e": "Azure DALL-E",
  "azure-gpt-image": "Azure GPT Image",
  "openrouter-paid": "OpenRouter Paid Keys", // <--- ADDED
  "openrouter-free": "OpenRouter Free Models", // <--- ADDED
};

const converter = new showdown.Converter();

/* optional markdown greeting */
const customGreeting = fs.existsSync("greeting.md")
  ? `<div id="servergreeting">${fs.readFileSync("greeting.md", "utf8")}</div>`
  : "";

/* ────────────────  Login page  ──────────────────────── */
function renderLoginPage(csrf: string, error?: string) {
  const errBlock = error
    ? `<div class="error-message">${escapeHtml(error)}</div>`
    : "";
  const pageTitle = getServerTitle();
  return `<!DOCTYPE html>
<html>
<head>
  <title>${pageTitle} – Login</title>
  <style>
    body{font-family:Arial, sans-serif;display:flex;justify-content:center;
         align-items:center;height:100vh;margin:0;padding:20px;background:#f5f5f5;}
    .login-container{background:#fff;border-radius:8px;box-shadow:0 4px 8px rgba(0,0,0,.1);
         padding:30px;width:100%;max-width:400px;text-align:center;}
    .logo-image{max-width:200px;margin-bottom:20px;}
    .form-group{margin-bottom:20px;}
    input[type=text], input[type=password]{width:100%;padding:10px;border:1px solid #ddd;border-radius:4px;
         box-sizing:border-box;font-size:16px;}
    button{background:#4caf50;color:#fff;border:none;padding:12px 20px;border-radius:4px;
         cursor:pointer;font-size:16px;width:100%;}
    button:hover{background:#45a049;}
    .error-message{color:#f44336;margin-bottom:15px;}

    @media (prefers-color-scheme: dark) {
      body { background: #2c2c2c; color: #e0e0e0; }
      .login-container { background: #383838; box-shadow: 0 4px 12px rgba(0,0,0,0.4); border: 1px solid #4a4a4a; }
      input[type=text], input[type=password] { background: #4a4a4a; color: #e0e0e0; border: 1px solid #5a5a5a; }
      input[type=text]::placeholder, input[type=password]::placeholder { color: #999; }
      button { background: #007bff; } /* Using a blue for dark mode button */
      button:hover { background: #0056b3; }
      .error-message { color: #ff8a80; } /* Lighter red for errors in dark mode */
    }
  </style>
</head>
<body>
  <div class="login-container">
    ${config.loginImageUrl ? `<img src="${config.loginImageUrl}" alt="Logo" class="logo-image">` : ''}
    ${errBlock}
    <form method="POST" action="${LOGIN_ROUTE}">
      <div class="form-group">
        ${config.serviceInfoAuthMode === "password"
          ? `<input type="password" id="password" name="password" required placeholder="Service Password">`
          : `<input type="text" id="token" name="token" required placeholder="Your token">`}
        <input type="hidden" name="_csrf" value="${csrf}">
      </div>
      <button type="submit">Access Dashboard</button>
    </form>
  </div>
</body>
</html>`;
}

/* ────────────────  login-required middleware  ──────────────── */
function requireLogin(
  req: Request,
  res: Response,
  next: express.NextFunction
) {
  if (req.session?.infoPageAuthed) return next();
  return res.send(renderLoginPage(res.locals.csrfToken));
}

/* ────────────────  INFO PAGE CACHING  ──────────────────────── */
let infoPageHtml: string | undefined;
let infoPageLastUpdated = 0;

export function handleInfoPage(req: Request, res: Response) {
  if (infoPageLastUpdated + INFO_PAGE_TTL > Date.now()) {
    return res.send(infoPageHtml);
  }

  const baseUrl =
    process.env.SPACE_ID && !req.get("host")?.includes("hf.space")
      ? getExternalUrlForHuggingfaceSpaceId(process.env.SPACE_ID)
      : req.protocol + "://" + req.get("host");

  const info = buildInfo(baseUrl + config.proxyEndpointRoute);
  infoPageHtml = renderPage(info);
  infoPageLastUpdated = Date.now();

  res.send(infoPageHtml);
}

/* ────────────────  RENDER FULL INFO PAGE  ──────────────────── */
export function renderPage(info: ServiceInfo) {
  const title = getServerTitle();
  const headerHtml = buildInfoPageHeader(info);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="robots" content="noindex" />
  <title>${title}</title>
  <link rel="stylesheet" href="/res/css/reset.css" />
  <link rel="stylesheet" href="/res/css/sakura.css" />
  <link rel="stylesheet" href="/res/css/sakura-dark.css"
        media="screen and (prefers-color-scheme: dark)" />
  <style>
    body{font-family:sans-serif;padding:1em;max-width:900px;margin:0;}
    .self-service-links{display:flex;justify-content:center;margin-bottom:1em;
                        padding:0.5em;font-size:0.8em;}
    .self-service-links a{margin:0 0.5em;}
  </style>
</head>
<body>
  ${headerHtml}
  <hr/>
  ${getSelfServiceLinks()}
  <h2>Service Info</h2>
  <pre>${JSON.stringify(info, null, 2)}</pre>
</body>
</html>`;
}

/* ────────────────  header & helper functions  ──────────────── */
/*     (all copied verbatim from original file)                  */
function buildInfoPageHeader(info: ServiceInfo) {
  const title = getServerTitle();
  let infoBody = `# ${title}`;

  if (config.promptLogging) {
    infoBody += `\n## Prompt Logging Enabled
This proxy keeps full logs of all prompts and AI responses. Prompt logs are anonymous and do not contain IP addresses or timestamps.

[You can see the type of data logged here, along with the rest of the code.](https://gitgud.io/khanon/oai-reverse-proxy/-/blob/main/src/shared/prompt-logging/index.ts).

**If you are uncomfortable with this, don't send prompts to this proxy!**`;
  }

  if (config.staticServiceInfo) {
    return converter.makeHtml(infoBody + customGreeting);
  }

  const waits: string[] = [];

  for (const modelFamily of config.allowedModelFamilies) {
    const service = MODEL_FAMILY_SERVICE[modelFamily];

    const hasKeys = keyPool.list().some(
      (k) => k.service === service && k.modelFamilies.includes(modelFamily)
    );

    const wait = info[modelFamily]?.estimatedQueueTime;
    if (hasKeys && wait) {
      waits.push(
        `**${MODEL_FAMILY_FRIENDLY_NAME[modelFamily] || modelFamily}**: ${wait}`
      );
    }
  }

  infoBody += "\n\n" + waits.join(" / ");
  infoBody += customGreeting;
  infoBody += buildRecentImageSection();

  return converter.makeHtml(infoBody);
}

function getSelfServiceLinks() {
  if (config.gatekeeper !== "user_token") return "";
  const links = [["Check your user token", "/user/lookup"]];
  if (config.captchaMode !== "none") {
    links.unshift(["Request a user token", "/user/captcha"]);
  }
  return `<div class="self-service-links">${links
    .map(([t, l]) => `<a href="${l}">${t}</a>`)
    .join(" | ")}</div>`;
}

function getServerTitle() {
  if (process.env.SERVER_TITLE) return process.env.SERVER_TITLE;
  if (process.env.SPACE_ID)
    return `${process.env.SPACE_AUTHOR_NAME} / ${process.env.SPACE_TITLE}`;
  if (process.env.RENDER)
    return `Render / ${process.env.RENDER_SERVICE_NAME}`;
  return "Tunnel";
}

function buildRecentImageSection() {
  const imageModels: ModelFamily[] = [
    "azure-dall-e",
    "dall-e",
    "gpt-image",
    "azure-gpt-image",
  ];
  // Condition 1: Is the feature enabled via config?
  // Condition 2: Is at least one relevant image model family allowed in config?
  if (
    !config.showRecentImages ||
    imageModels.every((f) => !config.allowedModelFamilies.includes(f))
  ) {
    return ""; // Exit if feature is disabled or no relevant models are allowed
  }

  // Condition 3: Are there any actual images to display?
  const recentImages = getLastNImages(12).reverse();
  if (recentImages.length === 0) {
    // If the feature is enabled and models are allowed, but no images exist,
    // do not render the section, including its title.
    return "";
  }

  // If all conditions pass (feature enabled, models allowed, images exist), build and return the HTML
  let html = `<h2>Recent Image Generations</h2>`;
  html += `<div style="display:flex;flex-wrap:wrap;" id="recent-images">`;
  for (const { url, prompt } of recentImages) {
    const thumbUrl = url.replace(/\.png$/, "_t.jpg");
    const escapedPrompt = escapeHtml(prompt);
    html += `<div style="margin:0.5em" class="recent-image">
<a href="${url}" target="_blank"><img src="${thumbUrl}" title="${escapedPrompt}"
 alt="${escapedPrompt}" style="max-width:150px;max-height:150px;"/></a></div>`;
  }
  html += `</div><p style="clear:both;text-align:center;">
<a href="/user/image-history">View all recent images</a></p>`;
  return html;
}

function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\[/g, "&#91;")
    .replace(/]/g, "&#93;");
}


function getExternalUrlForHuggingfaceSpaceId(spaceId: string) {
  try {
    const [u, s] = spaceId.split("/");
    return `https://${u}-${s.replace(/_/g, "-")}.hf.space`;
  } catch {
    return "";
  }
}

/* ────────────────  ROUTER  ─────────────────────────────────── */
const infoPageRouter = Router();

infoPageRouter.use(
  express.json({ limit: "1mb" }),
  express.urlencoded({ extended: true, limit: "1mb" }),
  withSession,
  injectCsrfToken,
  checkCsrfToken
);

/* login attempt */
infoPageRouter.post(LOGIN_ROUTE, (req, res) => {
  if (config.serviceInfoAuthMode === "password") {
    const password = (req.body.password || "").trim();
    // Simple string comparison; for production, consider a timing-safe comparison library
    if (config.serviceInfoPassword && password === config.serviceInfoPassword) {
      req.session!.infoPageAuthed = true;
      return res.redirect("/");
    } else {
      return res
        .status(401)
        .send(renderLoginPage(res.locals.csrfToken, "Invalid password. Please try again."));
    }
  } else {
    // Token-based authentication (using any valid user token)
    const token = (req.body.token || "").trim();
    const user = getUser(token); // returns undefined if invalid
    
    if (user && !user.disabledAt) {
      // Only allow access if user exists AND is not disabled
      req.session!.infoPageAuthed = true;
      return res.redirect("/");
    } else if (user && user.disabledAt) {
      // User exists but is disabled
      const reason = user.disabledReason || "Your account has been disabled";
      return res
        .status(401)
        .send(renderLoginPage(res.locals.csrfToken, `Access denied: ${reason}`));
    } else {
      // User doesn't exist
      return res
        .status(401)
        .send(renderLoginPage(res.locals.csrfToken, "Invalid token. Please try again."));
    }
  }
});

/* GET /  – either login form or info page */
if (config.enableInfoPageLogin) {
  infoPageRouter.get(LOGIN_ROUTE, requireLogin, handleInfoPage);
} else {
  infoPageRouter.get(LOGIN_ROUTE, handleInfoPage);
}

/*  ─── Removed the public /status route :  simply not added ─── */

export { infoPageRouter };
