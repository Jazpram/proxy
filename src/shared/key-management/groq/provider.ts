// src/shared/key-management/groq/provider.ts

import crypto from "crypto";
import { createGenericGetLockoutPeriod, Key, KeyProvider } from "..";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { GroqModelFamily, getGroqModelFamily } from "../../models";
import { PaymentRequiredError } from "../../errors";
import { GroqKeyChecker } from "./checker";

export type GroqKeyUpdate = Omit<
  Partial<GroqKey>,
  | "key"
  | "hash"
  | "lastUsed"
  | "promptCount"
  | "rateLimitedAt"
  | "rateLimitedUntil"
>;

export type GroqKeyStatus =
  | 'ACTIVE'
  | 'RATE_LIMITED'
  | 'INVALID'
  | 'DEAD'
  | 'UNKNOWN';

export interface GroqKey extends Key {
  readonly service: "groq";
  readonly modelFamilies: GroqModelFamily[];

  /** Current status of the key */
  status: GroqKeyStatus;
  /** Additional info from the checker (e.g., rate limit info) */
  info: string;
  /** Whether the key is over its quota/limit */
  isOverQuota: boolean;
  /** Rate limit information from the API */
  rateLimitInfo?: {
    rpm: number;
    tpm: number;
    rpd?: number;
    tpd?: number;
  };
}

const STATUS_PRIORITY: { [status in GroqKeyStatus]: number } = {
  'ACTIVE': 5,
  'RATE_LIMITED': 2,
  'UNKNOWN': 1,
  'INVALID': 0,
  'DEAD': 0,
};

const RATE_LIMIT_LOCKOUT = 60000; // 1 minute lockout for rate limits

export class GroqKeyProvider implements KeyProvider<GroqKey> {
  readonly service = "groq";

  private keys: GroqKey[] = [];
  private checker?: GroqKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.groqKey?.trim();
    if (!keyConfig) {
      this.log.warn(
        "GROQ_KEY is not set. Groq API will not be available."
      );
      return;
    }

    const bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: GroqKey = {
        key,
        service: this.service,
        modelFamilies: [
          "groq-llama-8b",
          "groq-llama-70b",
          "groq-llama-4-17b",
          "groq-gpt-oss-120b",
          "groq-gpt-oss-20b",
          "groq-kimi",
          "groq-qwen-32b"
        ],
        isDisabled: false,
        isRevoked: false,
        isOverQuota: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `groq-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        tokenUsage: {},
        status: 'UNKNOWN',
        info: 'Key not yet checked',
        rateLimitInfo: undefined,
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded Groq keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new GroqKeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(rawModel: string, streaming: boolean = false): GroqKey {
    this.log.debug({ model: rawModel }, "Selecting key");

    const requiredFamily = getGroqModelFamily(rawModel);

    const availableKeys = this.keys.filter((k) => {
      // 1. Must not be explicitly disabled
      if (k.isDisabled) return false;

      // 2. Must have a valid status
      if (STATUS_PRIORITY[k.status] === 0) return false;

      // 3. Must not be over quota
      if (k.isOverQuota) return false;

      // 4. Must not be rate limit locked
      const now = Date.now();
      const isRateLimited = now < k.rateLimitedUntil;
      if (isRateLimited) return false;

      // 5. Must support the model family
      return k.modelFamilies.includes(requiredFamily);
    });

    if (availableKeys.length === 0) {
      throw new PaymentRequiredError("No active Groq keys available.");
    }

    const keysByPriority = availableKeys.sort((a, b) => {
      // Priority 1: Status (higher is better)
      const aPriority = STATUS_PRIORITY[a.status];
      const bPriority = STATUS_PRIORITY[b.status];
      if (aPriority !== bPriority) return bPriority - aPriority;

      // Priority 2: Last Used (lower is better - LRU)
      return a.lastUsed - b.lastUsed;
    });

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = Date.now();
    return { ...selectedKey };
  }

  public disable(key: GroqKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<GroqKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;

    if (update.status) {
      const isOverQuota = update.status === 'RATE_LIMITED' || update.status === 'INVALID';

      update.isOverQuota = isOverQuota;

      if (update.status === 'DEAD' || update.status === 'INVALID') {
        update.isDisabled = true;
        update.isRevoked = update.status === 'DEAD';
      } else if (keyFromPool.status === 'DEAD' || keyFromPool.status === 'INVALID') {
        // Re-enable key if status is good now
        update.isDisabled = false;
        update.isRevoked = false;
      }
    }

    Object.assign(keyFromPool, { lastChecked: Date.now(), ...update });
  }

  public available() {
    return this.keys.filter((k) => !k.isDisabled).length;
  }

  public incrementUsage(keyHash: string, modelFamily: GroqModelFamily, usage: { input: number; output: number }) {
    const key = this.keys.find((k) => k.hash === keyHash);
    if (!key) return;

    key.promptCount++;

    if (!key.tokenUsage) {
      key.tokenUsage = {};
    }
    if (!key.tokenUsage[modelFamily]) {
      key.tokenUsage[modelFamily] = { input: 0, output: 0 };
    }

    const currentFamilyUsage = key.tokenUsage[modelFamily]!;
    currentFamilyUsage.input += usage.input;
    currentFamilyUsage.output += usage.output;
  }

  getLockoutPeriod = createGenericGetLockoutPeriod(() => this.keys);

  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + RATE_LIMIT_LOCKOUT;

    // Update status to rate limited
    this.update(keyHash, { status: 'RATE_LIMITED', info: 'Rate limited by proxy' });
  }

  public recheck() {
    this.keys.forEach((key) => {
      this.update(key.hash, {
        status: 'UNKNOWN',
        info: 'Recheck scheduled',
        isOverQuota: false,
        isDisabled: false,
        isRevoked: false,
        lastChecked: 0,
        rateLimitInfo: undefined,
      });
    });
    this.checker?.scheduleNextCheck();
  }
}