# Project Codebase Guide

This document serves as a guide and index for the project codebase, designed to help developers and AI agents quickly understand its structure, components, and how to contribute.

## Table of Contents

1.  [Project Overview](#project-overview)
2.  [Directory Structure](#directory-structure)
3.  [Core Components](#core-components)
    *   [Configuration (`src/config.ts`)](#configuration)
    *   [Server Entry Point (`src/server.ts`)](#server-entry-point)
    *   [Proxy Layer (`src/proxy/`)](#proxy-layer)
    *   [User Management (`src/user/`)](#user-management)
    *   [Admin Interface (`src/admin/`)](#admin-interface)
    *   [Shared Utilities (`src/shared/`)](#shared-utilities)
4.  [Proxy Functionality](#proxy-functionality)
    *   [Routing (`src/proxy/routes.ts`)](#proxy-routing)
    *   [Supported Models & Providers](#supported-models--providers)
    *   [Middleware (`src/proxy/middleware/`)](#proxy-middleware)
    *   [Adding New Models](#adding-new-models)
    *   [Adding New APIs/Providers](#adding-new-apisproviders)
5.  [Model Management](#model-management)
    *   [Model Family Definitions](#model-family-definitions)
    *   [Adding OpenAI Models](#adding-openai-models)
    *   [Model Mapping & Routing](#model-mapping--routing)
    *   [Service Information](#service-information)
    *   [Step-by-Step Guide for Adding a New Model](#step-by-step-guide-for-adding-a-new-model)
    *   [Model Patterns and Versioning](#model-patterns-and-versioning)
    *   [Response Format Handling](#response-format-handling)
6.  [Key Management](#key-management)
    *   [Key Pool System](#key-pool-system)
    *   [Provider-Specific Key Management](#provider-specific-key-management)
    *   [Key Rotation and Health Checks](#key-rotation-and-health-checks)
7.  [Data Management](#data-management)
    *   [Database (`src/shared/database/`)](#database)
    *   [File Storage (`src/shared/file-storage/`)](#file-storage)
8.  [Authentication & Authorization](#authentication--authorization)
9.  [Logging & Monitoring](#logging--monitoring)
10. [Deployment](#deployment)
11. [Contributing](#contributing)

## Project Overview

This project provides a proxy layer for various Large Language Models (LLMs) and potentially other AI APIs. It aims to offer a unified interface, manage API keys securely, handle rate limiting, usage tracking, and potentially add features like response caching or prompt modification.

## Directory Structure

```
.
├── .env.example          # Example environment variables
├── .gitattributes        # Git attributes
├── .gitignore            # Git ignore rules
├── .husky/               # Git hooks
├── .prettierrc           # Code formatting rules
├── CODEBASE_GUIDE.md     # This file
├── README.md             # Project README
├── data/                 # Data files (e.g., SQLite DB)
├── docker/               # Docker configuration
├── docs/                 # Documentation files
├── http-client.env.json  # HTTP client environment
├── package-lock.json     # NPM lock file
├── package.json          # Project dependencies and scripts
├── patches/              # Patches for dependencies
├── public/               # Static assets served by the web server
├── render.yaml           # Render deployment configuration
├── scripts/              # Utility scripts
├── src/                  # Source code
│   ├── admin/            # Admin interface logic
│   ├── config.ts         # Application configuration
│   ├── info-page.ts      # Logic for the info page
│   ├── logger.ts         # Logging setup
│   ├── proxy/            # Core proxy logic for different providers
│   ├── server.ts         # Express server setup and main entry point
│   ├── service-info.ts   # Service information logic
│   ├── shared/           # Shared utilities, types, and modules
│   └── user/             # User management logic
├── tsconfig.json         # TypeScript configuration
```

## Core Components

### Configuration (`src/config.ts`)

*   Loads environment variables and defines application settings.
*   Contains configuration for database connections, API keys (placeholders/retrieval methods), logging levels, rate limits, etc.
*   Uses `dotenv` and potentially a schema validation library (like Zod) to ensure required variables are present.

### Server Entry Point (`src/server.ts`)

*   Initializes the Express application.
*   Sets up core middleware (e.g., body parsing, CORS, logging).
*   Mounts routers for different parts of the application (admin, user, proxy).
*   Starts the HTTP server.

### Proxy Layer (`src/proxy/`)

*   The heart of the application, handling requests to downstream AI APIs.
*   Contains individual modules for each supported provider (e.g., `openai.ts`, `anthropic.ts`).
*   Handles request transformation, authentication against the target API, and response handling.
*   Uses middleware for common proxy tasks.

### User Management (`src/user/`)

*   Handles user registration, login, session management, and potentially API key generation/management for end-users.
*   Likely interacts with the database (`src/shared/database/`).

### Admin Interface (`src/admin/`)

*   Provides an interface for administrators to manage users, monitor usage, configure settings, etc.
*   May have its own set of routes and views.

### Shared Utilities (`src/shared/`)

*   Contains reusable code across different modules.
    *   `api-schemas/`: Zod schemas for API request/response validation.
    *   `database/`: Database connection, schemas (e.g., Prisma), and query logic.
    *   `errors.ts`: Custom error classes.
    *   `key-management/`: Logic for managing API keys (if applicable).
    *   `models.ts`: Core data models/types used throughout the application.
    *   `prompt-logging/`: Logic for logging prompts and responses.
    *   `tokenization/`: Utilities for counting tokens.
    *   `utils.ts`: General utility functions.

## Proxy Functionality

### Proxy Routing (`src/proxy/routes.ts`)

*   Defines the API endpoints for the proxy service (e.g., `/v1/chat/completions`).
*   Maps incoming requests to the appropriate provider-specific handler based on the request path, headers, or body content (e.g., model requested).
*   Applies relevant middleware (authentication, rate limiting, queuing, etc.).

### Supported Models & Providers

*   **OpenAI:** Handled in `src/proxy/openai.ts`. Supports models like GPT-4, GPT-3.5-turbo, as well as o-series models (o1, o1-mini, o1-pro, o3, o3-mini, o3-pro, o4-mini). Handles chat completions and potentially image generation (`src/proxy/openai-image.ts`).
*   **Anthropic:** Handled in `src/proxy/anthropic.ts`. Supports Claude models. May use AWS Bedrock (`src/proxy/aws-claude.ts`) or Anthropic's direct API.
*   **Google AI / Vertex AI:** Handled in `src/proxy/google-ai.ts` and `src/proxy/gcp.ts`. Supports Gemini models (gemini-flash, gemini-pro, gemini-ultra).
*   **Mistral AI:** Handled in `src/proxy/mistral-ai.ts`. Supports Mistral models via their API or potentially AWS (`src/proxy/aws-mistral.ts`).
*   **Azure OpenAI:** Handled in `src/proxy/azure.ts`. Provides an alternative endpoint for OpenAI models via Azure.
*   **Deepseek:** Handled in `src/proxy/deepseek.ts`.
*   **Xai:** Handled in `src/proxy/xai.ts`.
*   **AWS (General):** `src/proxy/aws.ts` might contain shared AWS logic (e.g., authentication).

### Middleware (`src/proxy/middleware/`)

*   **`gatekeeper.ts`:** Likely handles initial request validation, authentication, and authorization checks before hitting provider logic. Checks origin (`check-origin.ts`), potentially custom tokens (`check-risu-token.ts`).
*   **`rate-limit.ts`:** Implements rate limiting logic, potentially per-user or per-key.
*   **`queue.ts`:** Manages request queuing, possibly to handle concurrency limits or prioritize requests.

### Adding New Models

1.  **Identify the Provider:** Determine if the new model belongs to an existing provider (e.g., a new OpenAI model) or a new one.
2.  **Update Provider Logic (if existing):**
    *   Modify the relevant provider file (e.g., `src/proxy/openai.ts`).
    *   Update model lists or logic that selects/validates models.
    *   Adjust any request/response transformations if the new model has a different API schema.
    *   Update model information in shared files like `src/shared/models.ts` if necessary.
3.  **Update Routing (if necessary):** Modify `src/proxy/routes.ts` if the new model requires a different endpoint or routing logic.
4.  **Configuration:** Add any new API keys or configuration parameters to `.env.example` and `src/config.ts`.
5.  **Testing:** Add unit or integration tests for the new model.

### Adding New APIs/Providers

1.  **Create Provider Module:** Create a new file in `src/proxy/` (e.g., `src/proxy/new-provider.ts`).
2.  **Implement Handler:**
    *   Write the core logic to handle requests for this provider. This typically involves:
        *   Receiving the standardized request from the router.
        *   Transforming the request into the format expected by the new provider's API.
        *   Authenticating with the new provider's API (fetching keys from config).
        *   Making the API call (consider using a robust HTTP client like `axios` or `node-fetch`).
        *   Handling streaming responses if applicable (using helpers from `src/shared/streaming.ts`).
        *   Transforming the provider's response back into a standardized format.
        *   Handling errors gracefully.
3.  **Add Routing:**
    *   Import the new handler in `src/proxy/routes.ts`.
    *   Add new routes or modify existing routing logic to direct requests to the new handler based on model name, path, or other criteria.
    *   Apply necessary middleware (gatekeeper, rate limiter, queue).
4.  **Create Key Management:**
    *   Create a new directory in `src/shared/key-management/` for the provider.
    *   Implement provider-specific key management (key checkers, token counters).
5.  **Configuration:**
    *   Add configuration variables (API keys, base URLs) to `.env.example` and `src/config.ts`.
    *   Update `src/config.ts` to load and validate the new variables.
6.  **Model Information:** Add details about the new provider and its models to `src/shared/models.ts` or similar shared locations.
7.  **Tokenization (if applicable):** If token counting is needed, add or update tokenization logic in `src/shared/tokenization/`.
8.  **Testing:** Implement thorough tests for the new provider integration.
9.  **Documentation:** Update this guide and any other relevant documentation.

## Model Management

### Model Family Definitions

*   **Model Family Definitions:** The project uses a family-based approach to group similar models together. These are defined in `src/shared/models.ts`.
*   Each model is part of a model family (e.g., "gpt4", "claude", "gemini-pro") which helps with routing, key management, and feature support.
*   The `MODEL_FAMILIES` array contains all supported model families, and the `MODEL_FAMILY_SERVICE` mapping connects each family to its provider service.

### Adding OpenAI Models

When adding new OpenAI models to the codebase, there are several files that must be updated:

1. **Update Model Types (`src/shared/models.ts`):**
   - Add the new model to the `OpenAIModelFamily` type
   - Add the model to the `MODEL_FAMILIES` array
   - Add the Azure variants for the model if applicable
   - Add the model to `MODEL_FAMILY_SERVICE` mapping
   - Update `OPENAI_MODEL_FAMILY_MAP` with regex patterns to match the model names

2. **Update Context Size Limits (`src/proxy/middleware/request/preprocessors/validate-context-size.ts`):**
   - Add regex matching for the new model
   - Set the appropriate context token limit for the model

3. **Update Token Cost Tracking (`src/shared/stats.ts`):**
   - Add pricing information for the new model in the `getTokenCostUsd` function
   - Include both input and output prices in the comments for clarity

4. **Update Feature Support Checks (`src/proxy/openai.ts`):**
   - If the model supports special features like the reasoning API parameter (`isO1Model` function), update the appropriate function
   - For model feature detection, prefer using regex patterns over explicit lists when possible, as this handles date-stamped versions better

5. **Update Display Names (`src/info-page.ts`):**
   - Add friendly display names for the new models in the `MODEL_FAMILY_FRIENDLY_NAME` object

6. **Update Key Management Provider Files:**
   - For OpenAI keys in `src/shared/key-management/openai/provider.ts`, add token counters for the new models
   - For Azure OpenAI keys in `src/shared/key-management/azure/provider.ts`, add token counters for the Azure versions

### Model Patterns and Versioning

The codebase handles several patterns for model naming and versioning:

1. **Date-stamped Models:** Many models include date stamps (e.g., `gpt-4-0125-preview`). The regex patterns in `OPENAI_MODEL_FAMILY_MAP` account for these with patterns like `^gpt-4o(-\\d{4}-\\d{2}-\\d{2})?$`.

2. **O-Series Models:** OpenAI's o-series models (o1, o1-mini, o1-pro, o3, o3-mini, o3-pro, o4-mini) follow a different naming convention. The codebase handles these with dedicated model families and regex patterns.

3. **Preview/Non-Preview Variants:** Some models have preview variants (e.g., `gpt-4.5-preview`). The regex patterns in `OPENAI_MODEL_FAMILY_MAP` account for these with patterns like `^gpt-4\\.5(-preview)?(-\\d{4}-\\d{2}-\\d{2})?$`.

When adding new models, try to follow the existing patterns for consistency.

### Response Format Handling

The codebase includes special handling for different API response formats:

1. **Chat vs. Text Completions:** There's transformation logic in `openai.ts` to convert between chat completions and text completions formats (`transformTurboInstructResponse`).

2. **Newer API Formats:** For newer APIs like the Responses API, there's transformation logic (`transformResponsesApiResponse`) to convert responses to a format compatible with existing clients.

When adding support for new models or APIs, consider whether transformation is needed to maintain compatibility with existing clients.

## Key Management

### Key Pool System

The project uses a sophisticated key pool system (`src/shared/key-management/key-pool.ts`) to manage API keys for different providers. Key features include:

* **Key Selection:** The system selects the appropriate key based on model family, region preferences, and other criteria.
* **Rotation:** Keys are rotated to distribute usage and avoid hitting rate limits.
* **Health Checks:** Keys are checked periodically to ensure they're still valid and within rate limits.

### Provider-Specific Key Management

Each provider has its own key management module in `src/shared/key-management/`:

* **Key Checkers:** Each provider implements key checkers to validate keys and check their status.
* **Token Counters:** Providers implement token counting logic specific to their pricing model.
* **Models Support:** Keys are associated with specific model families they support.

When adding a new model or provider, you'll need to update or create the appropriate key management files.

### Key Rotation and Health Checks

The key pool system includes logic for:

* **Rotation Strategy:** Keys are selected based on a prioritization strategy (`prioritize-keys.ts`).
* **Disabling Unhealthy Keys:** Keys that fail health checks are temporarily disabled.
* **Rate Limit Awareness:** The system tracks usage to avoid hitting provider rate limits.

## Data Management

### Database (`src/shared/database/`)

*   Likely uses Prisma or a similar ORM.
*   Defines database schemas (e.g., for users, API keys, usage logs).
*   Provides functions for interacting with the database.
*   Configuration is managed in `src/config.ts`.

### File Storage (`src/shared/file-storage/`)

*   May be used for storing logs, cached data, or user-uploaded files.
*   Could integrate with local storage or cloud providers (e.g., S3, GCS).

## Authentication & Authorization

*   **User Auth:** Handled in `src/user/` potentially using sessions (`src/shared/with-session.ts`) or JWTs.
*   **Proxy Auth:** The `gatekeeper.ts` middleware likely verifies incoming requests to the proxy endpoints. This could involve checking:
    *   Custom API keys stored in the database (`src/shared/database/`).
    *   Specific tokens (`check-risu-token.ts`).
    *   HMAC signatures (`src/shared/hmac-signing.ts`).
    *   Origin checks (`check-origin.ts`).
*   **Downstream Auth:** Each provider module (`src/proxy/*.ts`) handles authentication with the actual AI service API using keys from the configuration.

## Logging & Monitoring

*   **Logging:** Configured in `src/logger.ts`, likely using a library like `pino` or `winston`. Logs requests, errors, and important events.
*   **Prompt Logging:** Specific logic for logging prompts and responses might exist in `src/shared/prompt-logging/`.
*   **Stats/Monitoring:** `src/shared/stats.ts` might handle collecting and exposing application metrics.

## Deployment

*   **Docker:** The project likely includes Docker configuration for containerized deployment.
*   **Render:** The `render.yaml` file suggests the project is or can be deployed on Render.
*   **Environment Variables:** The `.env.example` file provides a template for required environment variables in production.

## Contributing

When contributing to this project:

1. **Follow Coding Standards:** Use the established patterns and standards in the codebase. The `.prettierrc` file defines code formatting rules.
2. **Update Documentation:** Keep this guide updated when adding new components or changing existing ones.
3. **Add Tests:** Ensure your changes are tested appropriately.
4. **Update Configuration:** If your changes require new environment variables, update `.env.example`.

*This guide provides a high-level overview. For detailed information, refer to the specific source code files.* 
