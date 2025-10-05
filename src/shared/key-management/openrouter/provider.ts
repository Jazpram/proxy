// src/shared/key-management/openrouter/provider.ts

import crypto from "crypto";
import { createGenericGetLockoutPeriod, Key, KeyProvider } from "..";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { OpenRouterModuleFamily, getOpenRouterModuleFamily } from "../../models";
import { PaymentRequiredError } from "../../errors";
import { OpenRouterKeyChecker } from "./checker";

export type OpenRouterKeyUpdate = Omit<
  Partial<OpenRouterKey>,
  | "key"
  | "hash"
  | "lastUsed"
  | "promptCount"
  | "rateLimitedAt"
  | "rateLimitedUntil"
>;

export type OpenRouterKeyStatus = 
  | 'PAID (Balance)' 
  | 'PAID (No Credits)' // Вместо PAID (Pay-as-you-go)
  | 'PAID (Limit Reached)'
  | 'FREE (Active)' 
  | 'FREE (Exhausted)' 
  | 'DEAD' 
  | 'UNKNOWN (Rate Limited)';

export interface OpenRouterKey extends Key {
  readonly service: "openrouter";
  readonly modelFamilies: OpenRouterModuleFamily[];
  
  /** Current status of the key (from Python checker) */
  status: OpenRouterKeyStatus;
  /** Additional info from the checker (e.g., balance) */
  info: string;
  /** Whether the key is 'Paid' (i.e. not 'FREE', 'DEAD', or 'UNKNOWN') */
  isPaid: boolean;
  /** Whether the key is over its quota/limit (e.g., Free Exhausted, Paid No Credits/Limit Reached) */
  isOverQuota: boolean;
  /** The remaining balance or limit amount in USD. Null if not applicable/unknown. */
  remainingBalance: number | null; 
  /** Indicates if the key is explicitly a free tier key (based on API response). */
  isFreeTier: boolean; 
}

const STATUS_PRIORITY: { [status in OpenRouterKeyStatus]: number } = {
  'PAID (Balance)': 5,
  'FREE (Active)': 3,
  'PAID (No Credits)': 1,
  'PAID (Limit Reached)': 1,
  'FREE (Exhausted)': 1, 
  'DEAD': 0,
  'UNKNOWN (Rate Limited)': 0,
};

const RATE_LIMIT_LOCKOUT = 15000; // 15 seconds lockout for all tiers on 429

export class OpenRouterKeyProvider implements KeyProvider<OpenRouterKey> {
  readonly service = "openrouter";

  private keys: OpenRouterKey[] = [];
  private checker?: OpenRouterKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.openRouterKey?.trim();
    if (!keyConfig) {
      this.log.warn(
        "OPENROUTER_KEY is not set. OpenRouter API will not be available."
      );
      return;
    }
    let bareKeys: string[];
    bareKeys = [...new Set(keyConfig.split(",").map((k) => k.trim()))];
    for (const key of bareKeys) {
      const newKey: OpenRouterKey = {
        key,
        service: this.service,
        modelFamilies: ["openrouter-paid", "openrouter-free"], 
        isDisabled: false,
        isRevoked: false,
        isOverQuota: false,
        promptCount: 0,
        lastUsed: 0,
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        hash: `or-${crypto
          .createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 8)}`,
        lastChecked: 0,
        tokenUsage: {},
        status: 'UNKNOWN (Rate Limited)', 
        info: 'Key not yet checked',
        isPaid: false, // Default to false until checked
        remainingBalance: null, 
        isFreeTier: false, // Default to false until checked
      };
      this.keys.push(newKey);
    }
    this.log.info({ keyCount: this.keys.length }, "Loaded OpenRouter keys.");
  }

  public init() {
    if (config.checkKeys) {
      this.checker = new OpenRouterKeyChecker(this.keys, this.update.bind(this));
      this.checker.start();
    }
  }

  public list() {
    return this.keys.map((k) => Object.freeze({ ...k, key: undefined }));
  }

  public get(rawModel: string, streaming: boolean = false): OpenRouterKey {
    this.log.debug({ model: rawModel }, "Selecting key");
    
    const requiredFamily = getOpenRouterModuleFamily(rawModel);

    const availableKeys = this.keys.filter((k) => {
      // 1. Must not be explicitly disabled
      if (k.isDisabled) return false;
      // 2. Must be checked and have a non-DEAD/non-UNKNOWN status
      if (STATUS_PRIORITY[k.status] === 0) return false;
      
      // 3. Paid key logic: must be paid, and must have balance (if a balance is reported)
      if (requiredFamily === 'openrouter-paid') {
          if (!k.isPaid) return false; // Must be marked as Paid
          // If we know the balance, enforce it
          if (k.remainingBalance !== null && k.remainingBalance <= 0) return false; 
      }
      
      // 4. Free key logic: can be Free Active or a Paid key not used for Paid access
      if (requiredFamily === 'openrouter-free') {
          // If it's a Free Tier key, must be active
          if (k.isFreeTier && k.status === 'FREE (Exhausted)') return false;
          // Paid keys that are over quota can still be used for free access
      }

      // 5. Must not be rate limit locked
      const now = Date.now();
      const isRateLimited = now < k.rateLimitedUntil;
      if (isRateLimited) return false;
      
      // 6. Must support the model family (always true for OR keys here)
      return k.modelFamilies.includes(requiredFamily);
    });

    if (availableKeys.length === 0) {
      const message = requiredFamily === 'openrouter-paid'
        ? "No active OpenRouter Paid keys available (Balance depleted or key limit reached)."
        : "No active OpenRouter Free keys available (Free tier exhausted).";
      throw new PaymentRequiredError(message);
    }
    
    const keysByPriority = availableKeys.sort((a, b) => {
      // Priority 1: Status (higher is better)
      const aPriority = STATUS_PRIORITY[a.status];
      const bPriority = STATUS_PRIORITY[b.status];
      if (aPriority !== bPriority) return bPriority - aPriority;

      // Priority 2: Remaining Balance (higher is better)
      const aBalance = a.remainingBalance || 0;
      const bBalance = b.remainingBalance || 0;
      if (aBalance !== bBalance) return bBalance - aBalance;

      // Priority 3: Last Used (lower is better - LRU)
      return a.lastUsed - b.lastUsed;
    });

    const selectedKey = keysByPriority[0];
    selectedKey.lastUsed = Date.now();
    return { ...selectedKey };
  }

  public disable(key: OpenRouterKey) {
    const keyFromPool = this.keys.find((k) => k.hash === key.hash);
    if (!keyFromPool || keyFromPool.isDisabled) return;
    keyFromPool.isDisabled = true;
    this.log.warn({ key: key.hash }, "Key disabled");
  }

  public update(hash: string, update: Partial<OpenRouterKey>) {
    const keyFromPool = this.keys.find((k) => k.hash === hash)!;
    
    if (update.status) {
      const isPaid = update.status.startsWith('PAID');
      const isOverQuota = update.status.includes('No Credits') || update.status.includes('Exhausted') || update.status.includes('Limit Reached');
      
      update.isPaid = isPaid;
      update.isOverQuota = isOverQuota;
      
      // Update the explicit FreeTier flag based on new status
      update.isFreeTier = update.status.startsWith('FREE');
      
      if (update.status === 'DEAD' || update.status === 'UNKNOWN (Rate Limited)') {
        update.isDisabled = true;
        update.isRevoked = update.status === 'DEAD';
      }
      else if (keyFromPool.status === 'DEAD' || keyFromPool.status === 'UNKNOWN (Rate Limited)') {
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

  public incrementUsage(keyHash: string, modelFamily: OpenRouterModuleFamily, usage: { input: number; output: number }) {
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
  }

  public recheck() {
    this.keys.forEach((key) => {
      this.update(key.hash, {
        status: 'UNKNOWN (Rate Limited)',
        info: 'Recheck scheduled',
        isPaid: false, 
        isOverQuota: false,
        isDisabled: false, 
        isRevoked: false,
        lastChecked: 0,
        remainingBalance: null, 
        isFreeTier: false, 
      });
    });
    this.checker?.scheduleNextCheck();
  }
}