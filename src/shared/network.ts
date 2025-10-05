import axios, { AxiosInstance } from "axios";
import http from "http";
import https from "https";
import os from "os";
import { ProxyAgent } from "proxy-agent";
import { config } from "../config";
import { logger } from "../logger";

const log = logger.child({ module: "network" });

export type HttpAgent = http.Agent | https.Agent;

/** HTTP agent used by http-proxy-middleware when forwarding requests. */
let httpAgent: HttpAgent;
/** HTTPS agent used by http-proxy-middleware when forwarding requests. */
let httpsAgent: HttpAgent;
/** Axios instance used for any non-proxied requests. */
let axiosInstance: AxiosInstance;

function getInterfaceAddress(iface: string) {
  const ifaces = os.networkInterfaces();
  log.debug({ ifaces, iface }, "Found network interfaces.");
  if (!ifaces[iface]) {
    throw new Error(`Interface ${iface} not found.`);
  }

  const addresses = ifaces[iface]!.filter(
    ({ family, internal }) => family === "IPv4" && !internal
  );
  if (addresses.length === 0) {
    throw new Error(`Interface ${iface} has no external IPv4 addresses.`);
  }

  log.debug({ selected: addresses[0] }, "Selected network interface.");
  return addresses[0].address;
}

export function getHttpAgents() {
  if (httpAgent) return [httpAgent, httpsAgent];
  const { interface: iface, proxyUrl } = config.httpAgent || {};

  if (iface) {
    const address = getInterfaceAddress(iface);
    httpAgent = new http.Agent({ localAddress: address, keepAlive: true });
    httpsAgent = new https.Agent({ localAddress: address, keepAlive: true });
    log.info({ address }, "Using configured interface for outgoing requests.");
  } else if (proxyUrl) {
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.WS_PROXY = proxyUrl;
    process.env.WSS_PROXY = proxyUrl;
    httpAgent = new ProxyAgent();
    httpsAgent = httpAgent; // ProxyAgent automatically handles HTTPS
    const proxy = proxyUrl.replace(/:.*@/, "@******");
    log.info({ proxy }, "Using proxy server for outgoing requests.");
  } else {
    httpAgent = new http.Agent();
    httpsAgent = new https.Agent();
  }

  return [httpAgent, httpsAgent];
}

export function getAxiosInstance() {
  if (axiosInstance) return axiosInstance;

  const [httpAgent, httpsAgent] = getHttpAgents();
  axiosInstance = axios.create({ httpAgent, httpsAgent, proxy: false });
  return axiosInstance;
}
