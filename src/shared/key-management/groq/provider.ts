import { Key, KeyProvider, createGenericGetLockoutPeriod } from "..";
import { GroqKeyChecker } from "./checker";
import { config } from "../../../config";
import { logger } from "../../../logger";
import { GroqModelFamily, ModelFamily } from "../../models";

export interface GroqKey extends Key {
  readonly service: "groq";
  readonly modelFamilies: GroqModelFamily[];
  isOverQuota: boolean;
}

export class GroqKeyProvider implements KeyProvider<GroqKey> {
  readonly service = "groq";

  private keys: GroqKey[] = [];
  private checker?: GroqKeyChecker;
  private log = logger.child({ module: "key-provider", service: this.service });

  constructor() {
    const keyConfig = config.groqKey?.trim();
    if (!keyConfig) {
      this.log.warn("GROQ_KEY is not set. Groq API will not be available.");
      return;
    }

    const keys = keyConfig.split(",").map((k: string) => k.trim());
    for (const key of keys) {
      if (!key) continue;
      this.keys.push({
        key,
        service: this.service,
        modelFamilies: ["groq"], // Only parent family to avoid duplicate key checks
        isDisabled: false,
        isRevoked: false,
        promptCount: 0,
        lastUsed: 0,
        lastChecked: 0,
        hash: this.hashKey(key),
        rateLimitedAt: 0,
        rateLimitedUntil: 0,
        tokenUsage: {},
        isOverQuota: false,
      });
    }
  }

  private hashKey(key: string): string {
    return require("crypto").createHash("sha256").update(key).digest("hex");
  }

  public init() {
    if (this.keys.length === 0) return;
    if (!config.checkKeys) {
      this.log.warn(
        "Key checking is disabled. Keys will not be verified."
      );
      return;
    }
    this.checker = new GroqKeyChecker(this.update.bind(this));
    for (const key of this.keys) {
      void this.checker.checkKey(key);
    }
  }

  public get(model: string): GroqKey {
    const availableKeys = this.keys.filter((k) => !k.isDisabled);
    if (availableKeys.length === 0) {
      throw new Error("No Groq keys available");
    }
    const key = availableKeys[Math.floor(Math.random() * availableKeys.length)];
    key.lastUsed = Date.now();
    this.throttle(key.hash);
    return { ...key };
  }

  public list(): Omit<GroqKey, "key">[] {
    return this.keys.map(({ key, ...rest }) => rest);
  }

  public disable(key: GroqKey): void {
    const found = this.keys.find((k) => k.hash === key.hash);
    if (found) {
      found.isDisabled = true;
    }
  }

  public update(hash: string, update: Partial<GroqKey>): void {
    const key = this.keys.find((k) => k.hash === hash);
    if (key) {
      Object.assign(key, update);
    }
  }

  public available(): number {
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

    // Use "groq" as the parent family for token usage tracking
    // This ensures token usage is properly counted for the main Groq statistics
    const parentFamily = "groq";
    if (!key.tokenUsage[parentFamily]) {
      key.tokenUsage[parentFamily] = { input: 0, output: 0 };
    }
    const currentFamilyUsage = key.tokenUsage[parentFamily];
    currentFamilyUsage.input += usage.input;
    currentFamilyUsage.output += usage.output;
  }

  /**
   * Upon being rate limited, a key will be locked out for this many milliseconds
   * while we wait for other concurrent requests to finish.
   */
  private static readonly RATE_LIMIT_LOCKOUT = 2000;
  /**
   * Upon assigning a key, we will wait this many milliseconds before allowing it
   * to be used again. This is to prevent the queue from flooding a key with too
   * many requests while we wait to learn whether previous ones succeeded.
   */
  private static readonly KEY_REUSE_DELAY = 500;

  getLockoutPeriod = createGenericGetLockoutPeriod(() => this.keys);

  public markRateLimited(keyHash: string) {
    this.log.debug({ key: keyHash }, "Key rate limited");
    const key = this.keys.find((k) => k.hash === keyHash)!;
    const now = Date.now();
    key.rateLimitedAt = now;
    key.rateLimitedUntil = now + GroqKeyProvider.RATE_LIMIT_LOCKOUT;
  }

  public recheck(): void {
    if (!this.checker || !config.checkKeys) return;
    for (const key of this.keys) {
      this.update(key.hash, {
        isOverQuota: false,
        isDisabled: false,
        lastChecked: 0
      });
      void this.checker.checkKey(key);
    }
  }

  /**
   * Applies a short artificial delay to the key upon dequeueing, in order to
   * prevent it from being immediately assigned to another request before the
   * current one can be dispatched.
   **/
  private throttle(hash: string) {
    const now = Date.now();
    const key = this.keys.find((k) => k.hash === hash)!;

    const currentRateLimit = key.rateLimitedUntil;
    const nextRateLimit = now + GroqKeyProvider.KEY_REUSE_DELAY;

    key.rateLimitedAt = now;
    key.rateLimitedUntil = Math.max(currentRateLimit, nextRateLimit);
  }
}