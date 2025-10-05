# OAI Reverse Proxy - just a shitty fork
Reverse proxy server for various LLM APIs.

### Table of Contents
<!-- TOC -->
* [OAI Reverse Proxy](#oai-reverse-proxy)
    * [Table of Contents](#table-of-contents)
  * [What is this?](#what-is-this)
  * [Features](#features)
  * [Usage Instructions](#usage-instructions)
    * [Personal Use (single-user)](#personal-use-single-user)
      * [Updating](#updating)
      * [Local Development](#local-development)
    * [Self-hosting](#self-hosting)
  * [Building](#building)
  * [Forking](#forking)
<!-- TOC -->

## What is this?
This project allows you to run a reverse proxy server for various LLM APIs.

## Features
- [x] Support for multiple APIs
  - [x] [OpenAI](https://openai.com/)
  - [x] [Anthropic](https://www.anthropic.com/)
  - [x] [AWS Bedrock](https://aws.amazon.com/bedrock/) (Claude4 is fucked, dont care)
  - [x] [Vertex AI (GCP)](https://cloud.google.com/vertex-ai/)
  - [x] [Google MakerSuite/Gemini API](https://ai.google.dev/)
  - [x] [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service)
- [x] Translation from OpenAI-formatted prompts to any other API, including streaming responses
- [x] Multiple API keys with rotation and rate limit handling
- [x] Basic user management
  - [x] Simple role-based permissions
  - [x] Per-model token quotas
  - [x] Temporary user accounts
- [x] Event audit logging
- [x] Optional full logging of prompts and completions
- [x] Abuse detection and prevention
  - [x] IP address and user token model invocation rate limits
  - [x] IP blacklists
  - [x] Proof-of-work challenge for access by anonymous users

## Usage Instructions
If you'd like to run your own instance of this server, you'll need to deploy it somewhere and configure it with your API keys. A few easy options are provided below, though you can also deploy it to any other service you'd like if you know what you're doing and the service supports Node.js.

### Personal Use (single-user)
If you just want to run the proxy server to use yourself without hosting it for others:
1. Install [Node.js](https://nodejs.org/en/download/) >= 18.0.0
2. Clone this repository
3. Create a `.env` file in the root of the project and add your API keys. See the [.env.example](./.env.example) file for an example.
4. Install dependencies with `npm install`
5. Run `npm run build`
6. Run `npm start`

#### Updating
You must re-run `npm install` and `npm run build` whenever you pull new changes from the repository.

#### Local Development
Use `npm run start:dev` to run the proxy in development mode with watch mode enabled. Use `npm run type-check` to run the type checker across the project.

### Self-hosting
[See here for instructions on how to self-host the application on your own VPS or local machine and expose it to the internet for others to use.](./docs/self-hosting.md)

**Ensure you set the `TRUSTED_PROXIES` environment variable according to your deployment.** Refer to [.env.example](./.env.example) and [config.ts](./src/config.ts) for more information.

## Building
To build the project, run `npm run build`. This will compile the TypeScript code to JavaScript and output it to the `build` directory. You should run this whenever you pull new changes from the repository.

Note that if you are trying to build the server on a very memory-constrained (<= 1GB) VPS, you may need to run the build with `NODE_OPTIONS=--max_old_space_size=2048 npm run build` to avoid running out of memory during the build process, assuming you have swap enabled.  The application itself should run fine on a 512MB VPS for most reasonable traffic levels.

## Forking
If you are forking the repository on GitGud, you may wish to disable GitLab CI/CD or you will be spammed with emails about failed builds due not having any CI runners. You can do this by going to *Settings > General > Visibility, project features, permissions* and then disabling the "CI/CD" feature.
