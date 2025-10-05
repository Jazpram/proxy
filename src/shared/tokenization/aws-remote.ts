import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { getAxiosInstance } from "../network";
import { logger } from "../../logger";
import { AwsBedrockKey } from "../key-management/aws/provider";

const log = logger.child({ module: "tokenizer", service: "aws-remote" });

const AMZ_HOST =
  process.env.AMZ_HOST || "bedrock-runtime.%REGION%.amazonaws.com";

export interface AwsTokenCountRequest {
  input: {
    invokeModel: {
      body: string; // base64-encoded JSON string
    };
  };
}

export interface AwsTokenCountResponse {
  inputTokens: number;
}

type Credential = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
};

function getCredentialParts(key: AwsBedrockKey): Credential {
  const [accessKeyId, secretAccessKey, region] = key.key.split(":");

  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error("AWS_CREDENTIALS isn't correctly formatted");
  }

  return { accessKeyId, secretAccessKey, region };
}

async function sign(request: HttpRequest, credential: Credential) {
  const { accessKeyId, secretAccessKey, region } = credential;

  const signer = new SignatureV4({
    sha256: Sha256,
    credentials: { accessKeyId, secretAccessKey },
    region,
    service: "bedrock",
  });

  return signer.sign(request);
}

/**
 * Counts tokens using AWS Bedrock's remote token counting API endpoint.
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_CountTokens.html
 */
export async function countTokensRemote(
  modelId: string,
  request: AwsTokenCountRequest,
  key: AwsBedrockKey
): Promise<{ token_count: number; tokenizer: string }> {
  const axios = getAxiosInstance();
  const credential = getCredentialParts(key);
  const host = AMZ_HOST.replace("%REGION%", credential.region);

  // Create the HTTP request to sign
  const httpRequest = new HttpRequest({
    method: "POST",
    protocol: "https:",
    hostname: host,
    path: `/model/${modelId}/count-tokens`,
    headers: {
      ["Host"]: host,
      ["content-type"]: "application/json",
    },
    body: JSON.stringify(request),
  });

  try {
    // Sign the request using AWS Signature V4
    const signedRequest = await sign(httpRequest, credential);

    // Make the request
    const response = await axios.post<AwsTokenCountResponse>(
      `https://${host}${signedRequest.path}`,
      signedRequest.body,
      {
        headers: signedRequest.headers as Record<string, string>,
        timeout: 5000, // 5 second timeout
      }
    );

    log.debug(
      {
        modelId,
        input_tokens: response.data.inputTokens,
      },
      "Counted tokens via AWS Bedrock API"
    );

    return {
      token_count: response.data.inputTokens,
      tokenizer: "aws-bedrock-remote-api",
    };
  } catch (error: any) {
    log.warn(
      {
        error: error.message,
        status: error.response?.status,
        data: error.response?.data,
      },
      "Failed to count tokens via AWS Bedrock API, will fall back to local tokenizer"
    );
    throw error;
  }
}