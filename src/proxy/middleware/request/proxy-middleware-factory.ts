import { Request, Response } from "express";
import http from "http";
import ProxyServer from "http-proxy";
import { Readable } from "stream";
import {
  createProxyMiddleware,
  Options,
  debugProxyErrorsPlugin,
  proxyEventsPlugin,
} from "http-proxy-middleware";
import { ProxyReqMutator, stripHeaders } from "./index";
import { createOnProxyResHandler, ProxyResHandlerWithBody } from "../response";
import { createQueueMiddleware } from "../../queue";
import { getHttpAgents } from "../../../shared/network";
import { classifyErrorAndSend } from "../common";

/**
 * Options for the `createQueuedProxyMiddleware` factory function.
 */
type ProxyMiddlewareFactoryOptions = {
  /**
   * Functions which receive a ProxyReqManager and can modify the request before
   * it is proxied. The modifications will be automatically reverted if the
   * request needs to be returned to the queue.
   */
  mutations?: ProxyReqMutator[];
  /**
   * The target URL to proxy requests to. This can be a string or a function
   * which accepts the request and returns a string.
   */
  target: string | Options<Request>["router"];
  /**
   * A function which receives the proxy response and the JSON-decoded request
   * body. Only fired for non-streaming responses; streaming responses are
   * handled in `handle-streaming-response.ts`.
   */
  blockingResponseHandler?: ProxyResHandlerWithBody;
};

/**
 * Returns a middleware function that accepts incoming requests and places them
 * into the request queue. When the request is dequeued, it is proxied to the
 * target URL using the given options and middleware. Non-streaming responses
 * are handled by the given `blockingResponseHandler`.
 */
export function createQueuedProxyMiddleware({
  target,
  mutations,
  blockingResponseHandler,
}: ProxyMiddlewareFactoryOptions) {
  const hpmTarget = typeof target === "string" ? target : "https://setbyrouter";
  const hpmRouter = typeof target === "function" ? target : undefined;

  const [httpAgent, httpsAgent] = getHttpAgents();
  const agent = hpmTarget.startsWith("http:") ? httpAgent : httpsAgent;

  const proxyMiddleware = createProxyMiddleware<Request, Response>({
    target: hpmTarget,
    router: hpmRouter,
    agent,
    changeOrigin: true,
    toProxy: true,
    selfHandleResponse: typeof blockingResponseHandler === "function",
    // Disable HPM logger plugin (requires re-adding the other default plugins).
    // Contrary to name, debugProxyErrorsPlugin is not just for debugging and
    // fixes several error handling/connection close issues in http-proxy core.
    ejectPlugins: true,
    // Inferred (via Options<express.Request>) as Plugin<express.Request>, but
    // the default plugins only allow http.IncomingMessage for TReq. They are
    // compatible with express.Request, so we can use them. `Plugin` type is not
    // exported for some reason.
    plugins: [
      debugProxyErrorsPlugin,
      pinoLoggerPlugin,
      proxyEventsPlugin,
    ] as any,
    on: {
      proxyRes: createOnProxyResHandler(
        blockingResponseHandler ? [blockingResponseHandler] : []
      ),
      error: classifyErrorAndSend,
    },
    buffer: ((req: Request) => {
      // This is a hack/monkey patch and is not part of the official
      // http-proxy-middleware package. See patches/http-proxy+1.18.1.patch.
      let payload = req.body;
      if (typeof payload === "string") {
        payload = Buffer.from(payload);
      }
      const stream = new Readable();
      stream.push(payload);
      stream.push(null);
      return stream;
    }) as any,
  });

  return createQueueMiddleware({
    mutations: [stripHeaders, ...(mutations ?? [])],
    proxyMiddleware,
  });
}

type ProxiedResponse = http.IncomingMessage & Response & any;
function pinoLoggerPlugin(proxyServer: ProxyServer<Request>) {
  proxyServer.on("error", (err, req, res, target) => {
    req.log.error(
      { originalUrl: req.originalUrl, targetUrl: String(target), err },
      "Error occurred while proxying request to target"
    );
  });
  proxyServer.on("proxyReq", (proxyReq, req) => {
    const { protocol, host, path } = proxyReq;
    req.log.info(
      {
        from: req.originalUrl,
        to: `${protocol}//${host}${path}`,
      },
      "Sending request to upstream API..."
    );
  });
  proxyServer.on("proxyRes", (proxyRes: ProxiedResponse, req, _res) => {
    const { protocol, host, path } = proxyRes.req;
    req.log.info(
      {
        target: `${protocol}//${host}${path}`,
        status: proxyRes.statusCode,
        contentType: proxyRes.headers["content-type"],
        contentEncoding: proxyRes.headers["content-encoding"],
        contentLength: proxyRes.headers["content-length"],
        transferEncoding: proxyRes.headers["transfer-encoding"],
      },
      "Got response from upstream API."
    );
  });
}
