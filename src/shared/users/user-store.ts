/**
 * Basic user management. Handles creation and tracking of proxy users, personal
 * access tokens, and quota management. Supports in-memory and Firebase Realtime
 * Database persistence stores.
 *
 * Users are identified solely by their personal access token. The token is
 * used to authenticate the user for all proxied requests.
 */

import admin from "firebase-admin";
import schedule from "node-schedule";
import { v4 as uuid } from "uuid";
import type { Database } from 'better-sqlite3';
import { config } from "../../config";
import { logger } from "../../logger";
import { getFirebaseApp } from "../firebase";
import { initSQLiteDB, getDB } from "../sqlite-db"; // Added
import { APIFormat } from "../key-management";
import {
  getAwsBedrockModelFamily,
  getGcpModelFamily,
  getAzureOpenAIModelFamily,
  getClaudeModelFamily,
  getGoogleAIModelFamily,
  getMistralAIModelFamily,
  getOpenAIModelFamily,
  getOpenRouterModuleFamily,
  MODEL_FAMILIES,
  ModelFamily,
} from "../models";
import { assertNever } from "../utils";
import { User, UserTokenCounts, UserTokenLimits, UserUpdate } from "./schema";

const log = logger.child({ module: "users" });

const INITIAL_TOKENS: Required<UserTokenCounts> = MODEL_FAMILIES.reduce(
  (acc, family) => {
    acc[family] = { input: 0, output: 0 }; // legacy_total is undefined by default
    return acc;
  },
  {} as Record<ModelFamily, { input: number; output: number; legacy_total?: number }>
) as Required<UserTokenCounts>;

const migrateTokenCountsProperty = (
  parsedProperty: any, // Data from DB (JSON.parse result for a specific user's property like tokenCounts)
  defaultConfigForProperty: Record<ModelFamily, number | { input: number; output: number; legacy_total?: number } | undefined> // e.g., INITIAL_TOKENS or config.tokenQuota
): UserTokenCounts => {
  const result = {} as UserTokenCounts;

  for (const family of MODEL_FAMILIES) {
    const dbValue = parsedProperty?.[family];
    const configValue = defaultConfigForProperty[family];

    if (typeof dbValue === 'number') {
      // Case 1: DB has old numeric format - migrate to legacy_total only (no double counting)
      result[family] = { input: 0, output: 0, legacy_total: dbValue };
    } else if (typeof dbValue === 'object' && dbValue !== null && (typeof dbValue.input === 'number' || typeof dbValue.output === 'number')) {
      // Case 2: DB has new object format (might or might not have legacy_total from a previous migration)
      const migratedCounts: { input: number; output: number; legacy_total?: number } = { 
        input: dbValue.input ?? 0, 
        output: dbValue.output ?? 0 
      };
      if (dbValue.legacy_total !== undefined) {
        migratedCounts.legacy_total = dbValue.legacy_total;
      }
      result[family] = migratedCounts;
    } else {
      // Case 3: DB value is missing or invalid, use default from config
      if (typeof configValue === 'number') {
        // Default from config is old numeric format - migrate to legacy_total only
        result[family] = { input: 0, output: 0, legacy_total: configValue };
      } else if (typeof configValue === 'object' && configValue !== null && (typeof configValue.input === 'number' || typeof configValue.output === 'number')) {
        // Default from config is new object format (e.g., INITIAL_TOKENS[family])
        const configCounts: { input: number; output: number; legacy_total?: number } = { 
          input: configValue.input ?? 0, 
          output: configValue.output ?? 0 
        };
        if (configValue.legacy_total !== undefined) {
          configCounts.legacy_total = configValue.legacy_total;
        }
        result[family] = configCounts;
      } else {
        // Ultimate fallback: if configValue is also missing or invalid for this family
        result[family] = { input: 0, output: 0 }; // No legacy_total here
      }
    }
  }
  return result;
};

// Migration function for tokenLimits/tokenRefresh to flat numbers
const migrateTokenLimitsProperty = (
  parsedProperty: any, // Data from DB
  defaultConfigForProperty: Record<ModelFamily, number | undefined> // e.g., config.tokenQuota
): UserTokenLimits => {
  const result = {} as UserTokenLimits;

  for (const family of MODEL_FAMILIES) {
    const dbValue = parsedProperty?.[family];
    const configValue = defaultConfigForProperty[family];

    if (typeof dbValue === 'number') {
      // Already in correct format
      result[family] = dbValue;
    } else if (typeof dbValue === 'object' && dbValue !== null) {
      // Old format with input/output/legacy_total - sum them up
      const total = (dbValue.input ?? 0) + (dbValue.output ?? 0) + (dbValue.legacy_total ?? 0);
      result[family] = total > 0 ? total : (configValue ?? 0);
    } else {
      // Missing or invalid - use config default
      result[family] = configValue ?? 0;
    }
  }
  return result;
};

const users: Map<string, User> = new Map();
const usersToFlush = new Set<string>();
let quotaRefreshJob: schedule.Job | null = null;
let userCleanupJob: schedule.Job | null = null;

export async function init() {
  log.info({ store: config.gatekeeperStore }, "Initializing user store...");
  if (config.gatekeeperStore === "firebase_rtdb") {
    await initFirebase();
  } else if (config.gatekeeperStore === "sqlite") {
    await initSQLite(); // Added
  }
  if (config.quotaRefreshPeriod) {
    const crontab = getRefreshCrontab();
    quotaRefreshJob = schedule.scheduleJob(crontab, refreshAllQuotas);
    if (!quotaRefreshJob) {
      throw new Error(
        "Unable to schedule quota refresh. Is QUOTA_REFRESH_PERIOD set correctly?"
      );
    }
    log.debug(
      { nextRefresh: quotaRefreshJob.nextInvocation() },
      "Scheduled token quota refresh."
    );
  }

  userCleanupJob = schedule.scheduleJob("* * * * *", cleanupExpiredTokens);

  log.info("User store initialized.");
}

/**
 * Creates a new user and returns their token. Optionally accepts parameters
 * for setting an expiry date and/or token limits for temporary users.
 **/
export function createUser(createOptions?: {
  type?: User["type"];
  expiresAt?: number;
  tokenLimits?: User["tokenLimits"];
  tokenRefresh?: User["tokenRefresh"];
}) {
  const token = uuid();
  const newUser: User = {
    token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { ...INITIAL_TOKENS },
    tokenLimits: createOptions?.tokenLimits ?? MODEL_FAMILIES.reduce((acc, family) => {
      acc[family] = config.tokenQuota[family] ?? 0;
      return acc;
    }, {} as UserTokenLimits),
    tokenRefresh: createOptions?.tokenRefresh ?? MODEL_FAMILIES.reduce((acc, family) => {
      acc[family] = config.tokenQuota[family] ?? 0;
      return acc;
    }, {} as UserTokenLimits),
    createdAt: Date.now(),
    meta: {},
  };

  if (createOptions?.type === "temporary") {
    Object.assign(newUser, {
      type: "temporary",
      expiresAt: createOptions.expiresAt,
    });
  } else {
    Object.assign(newUser, { type: createOptions?.type ?? "normal" });
  }

  users.set(token, newUser);
  usersToFlush.add(token);
  return token;
}

/** Returns the user with the given token if they exist. */
export function getUser(token: string) {
  return users.get(token);
}

/** Returns a list of all users. */
export function getUsers() {
  return Array.from(users.values()).map((user) => ({ ...user }));
}

/**
 * Upserts the given user. Intended for use with the /admin API for updating
 * arbitrary fields on a user; use the other functions in this module for
 * specific use cases. `undefined` values are left unchanged. `null` will delete
 * the property from the user.
 *
 * Returns the upserted user.
 */
export function upsertUser(user: UserUpdate) {
  const existing: User = users.get(user.token) ?? {
    token: user.token,
    ip: [],
    type: "normal",
    promptCount: 0,
    tokenCounts: { ...INITIAL_TOKENS },
    tokenLimits: MODEL_FAMILIES.reduce((acc, family) => {
      acc[family] = config.tokenQuota[family] ?? 0;
      return acc;
    }, {} as UserTokenLimits),
    tokenRefresh: MODEL_FAMILIES.reduce((acc, family) => {
      acc[family] = config.tokenQuota[family] ?? 0;
      return acc;
    }, {} as UserTokenLimits),
    createdAt: Date.now(),
    meta: {},
  };

  const updates: Partial<User> = {};

  for (const field of Object.entries(user)) {
    const [key, value] = field as [keyof User, any]; // already validated by zod
    if (value === undefined || key === "token") continue;
    if (value === null) {
      delete existing[key];
    } else {
      updates[key] = value;
    }
  }

  if (updates.tokenCounts) {
    for (const family of MODEL_FAMILIES) {
      // Preserve existing legacy_total when creating default token counts
      const existingCounts = existing.tokenCounts[family];
      const defaultCounts: { input: number; output: number; legacy_total?: number } = { input: 0, output: 0 };
      if (existingCounts?.legacy_total !== undefined) {
        defaultCounts.legacy_total = existingCounts.legacy_total;
      }
      updates.tokenCounts[family] ??= defaultCounts;
      
      // The property is now guaranteed to be an object, so the 'number' check is removed.
      // Defaulting individual fields if they are missing.
      const counts = updates.tokenCounts[family]!; // Should not be undefined here
      counts.input ??= 0;
      counts.output ??= 0;
      // Preserve legacy_total from existing data if not already set in updates
      if (counts.legacy_total === undefined && existingCounts?.legacy_total !== undefined) {
        counts.legacy_total = existingCounts.legacy_total;
      }
    }
  }
  if (updates.tokenLimits) {
    for (const family of MODEL_FAMILIES) {
      updates.tokenLimits[family] ??= 0;
    }
  }
  if (updates.tokenRefresh) {
    for (const family of MODEL_FAMILIES) {
      updates.tokenRefresh[family] ??= 0;
    }
  }

  users.set(user.token, Object.assign(existing, updates));
  usersToFlush.add(user.token);

  // Immediately schedule a flush to the database if a persistent store is used.
  if (config.gatekeeperStore === "firebase_rtdb") {
    setImmediate(flushUsers);
  } else if (config.gatekeeperStore === "sqlite") {
    setImmediate(flushUsersToSQLite);
  }

  return users.get(user.token);
}

/** Increments the prompt count for the given user. */
export function incrementPromptCount(token: string) {
  const user = users.get(token);
  if (!user) return;
  user.promptCount++;
  usersToFlush.add(token);
}

/** Increments token consumption for the given user and model. */
export function incrementTokenCount(
  token: string,
  model: string,
  api: APIFormat,
  consumption: { input: number; output: number }
) {
  const user = users.get(token);
  if (!user) return;
  const modelFamily = getModelFamilyForQuotaUsage(model, api);
  const existingCounts = user.tokenCounts[modelFamily] ?? { input: 0, output: 0 };
  
  // Ensure consumption values are non-negative
  const safeInput = Math.max(0, consumption.input);
  const safeOutput = Math.max(0, consumption.output);
  
  const newCounts: { input: number; output: number; legacy_total?: number } = {
    input: (existingCounts.input ?? 0) + safeInput,
    output: (existingCounts.output ?? 0) + safeOutput
  };
  
  // Only include legacy_total if it has a defined value
  if (existingCounts.legacy_total !== undefined) {
    newCounts.legacy_total = existingCounts.legacy_total;
  }
  
  user.tokenCounts[modelFamily] = newCounts;
  usersToFlush.add(token);
}

/**
 * Given a user's token and IP address, authenticates the user and adds the IP
 * to the user's list of IPs. Returns the user if they exist and are not
 * disabled, otherwise returns undefined.
 */
export function authenticate(
  token: string,
  ip: string
): { user?: User; result: "success" | "disabled" | "not_found" | "limited" } {
  const user = users.get(token);
  if (!user) return { result: "not_found" };
  if (user.disabledAt) return { result: "disabled" };

  const newIp = !user.ip.includes(ip);

  const userLimit = user.maxIps ?? config.maxIpsPerUser;
  const enforcedLimit =
    user.type === "special" || !userLimit ? Infinity : userLimit;

  if (newIp && user.ip.length >= enforcedLimit) {
    if (config.maxIpsAutoBan) {
      user.ip.push(ip);
      disableUser(token, "IP address limit exceeded.");
      return { result: "disabled" };
    }
    return { result: "limited" };
  } else if (newIp) {
    user.ip.push(ip);
  }

  user.lastUsedAt = Date.now();
  usersToFlush.add(token);
  return { user, result: "success" };
}

export function hasAvailableQuota({
  userToken,
  model,
  api,
  requested,
}: {
  userToken: string;
  model: string;
  api: APIFormat;
  requested: number;
}) {
  const user = users.get(userToken);
  if (!user) return false;
  if (user.type === "special") return true;

  const modelFamily = getModelFamilyForQuotaUsage(model, api);
  const { tokenCounts, tokenLimits } = user;
  const currentUsage = tokenCounts[modelFamily] ?? { input: 0, output: 0 };

  // Calculate total tokens consumed so far (including legacy)
  // Ensure all values are non-negative to prevent overflow issues
  const input = Math.max(0, currentUsage.input ?? 0);
  const output = Math.max(0, currentUsage.output ?? 0);
  const legacy = Math.max(0, currentUsage.legacy_total ?? 0);
  
  // Use safe addition to prevent integer overflow
  const totalConsumed = input + output + legacy;
  
  // Sanity check - if total is negative or NaN, something went wrong
  if (!Number.isFinite(totalConsumed) || totalConsumed < 0) {
    log.error({
      userToken,
      modelFamily,
      input,
      output,
      legacy,
      totalConsumed
    }, "Invalid token consumption calculation");
    return false;
  }

  // Get the quota limit as a single number
  const limit = tokenLimits[modelFamily] ?? config.tokenQuota[modelFamily] ?? 0;

  // If no limit (0 or undefined), quota is unlimited
  if (!limit || limit === 0) return true;
  
  // Ensure requested is non-negative
  const safeRequested = Math.max(0, requested);
  
  // Check if the request would exceed the limit
  return (totalConsumed + safeRequested) <= limit;
}

/**
 * For the given user, refreshes token limits for each model family. The new limit
 * is set to the current usage + the refresh amount, ensuring users get their full
 * refresh allocation regardless of current usage.
 */
export function refreshQuota(token: string) {
  const user = users.get(token);
  if (!user) return;
  const { tokenCounts, tokenLimits, tokenRefresh } = user;

  for (const family of MODEL_FAMILIES) {
    // Get the quota value to add (from user refresh config or global default)
    const userQuota = tokenRefresh[family] ?? 0;
    const globalQuota = config.tokenQuota[family] ?? 0;
    const quotaToAdd = userQuota || globalQuota;

    if (quotaToAdd > 0) {
      // Calculate current usage including legacy
      const currentUsage = tokenCounts[family] ?? { input: 0, output: 0 };
      const input = Math.max(0, currentUsage.input ?? 0);
      const output = Math.max(0, currentUsage.output ?? 0);
      const legacy = Math.max(0, currentUsage.legacy_total ?? 0);
      const totalUsage = input + output + legacy;
      
      // Set new limit to current usage + refresh amount
      // This ensures users always get their full refresh allocation
      tokenLimits[family] = totalUsage + quotaToAdd;
    }
  }
  usersToFlush.add(token);
}

export function resetUsage(token: string) {
  const user = users.get(token);
  if (!user) return;
  const { tokenCounts } = user;
  for (const family of MODEL_FAMILIES) {
    const existing = tokenCounts[family];
    // Preserve legacy_total when resetting usage
    const resetCounts: { input: number; output: number; legacy_total?: number } = { 
      input: 0, 
      output: 0
    };
    
    // Only include legacy_total if it has a defined value
    if (existing?.legacy_total !== undefined) {
      resetCounts.legacy_total = existing.legacy_total;
    }
    
    tokenCounts[family] = resetCounts;
  }
  usersToFlush.add(token);
}

/** Disables the given user, optionally providing a reason. */
export function disableUser(token: string, reason?: string) {
  const user = users.get(token);
  if (!user) return;
  user.disabledAt = Date.now();
  user.disabledReason = reason;
  if (!user.meta) {
    user.meta = {};
  }
  // manually banned tokens cannot be refreshed
  user.meta.refreshable = false;
  usersToFlush.add(token);
}

export function getNextQuotaRefresh() {
  if (!quotaRefreshJob) return "never (manual refresh only)";
  return quotaRefreshJob.nextInvocation().getTime();
}

/**
 * Cleans up expired temporary tokens by disabling tokens past their access
 * expiry date and permanently deleting tokens three days after their access
 * expiry date.
 */
function cleanupExpiredTokens() {
  const now = Date.now();
  let disabled = 0;
  let deleted = 0;
  for (const user of users.values()) {
    if (user.type !== "temporary") continue;
    if (user.expiresAt && user.expiresAt < now && !user.disabledAt) {
      disableUser(user.token, "Temporary token expired.");
      if (!user.meta) {
        user.meta = {};
      }
      user.meta.refreshable = config.captchaMode !== "none";
      disabled++;
    }
    const purgeTimeout = config.powTokenPurgeHours * 60 * 60 * 1000;
    if (user.disabledAt && user.disabledAt + purgeTimeout < now) {
      users.delete(user.token);
      usersToFlush.add(user.token);
      deleted++;
    }
  }
  log.trace({ disabled, deleted }, "Expired tokens cleaned up.");
}

function refreshAllQuotas() {
  let count = 0;
  for (const user of users.values()) {
    if (user.type === "temporary") continue;
    refreshQuota(user.token);
    count++;
  }
  log.info(
    { refreshed: count, nextRefresh: quotaRefreshJob!.nextInvocation() },
    "Token quotas refreshed."
  );
}

// TODO: Firebase persistence is pretend right now and just polls the in-memory
// store to sync it with Firebase when it changes. Will refactor to abstract
// persistence layer later so we can support multiple stores.
let firebaseTimeout: NodeJS.Timeout | undefined;
let sqliteInterval: NodeJS.Timeout | undefined; // Added
let flushingToSQLiteInProgress = false; // Added for JS-level lock
const USERS_REF = process.env.FIREBASE_USERS_REF_NAME ?? "users";

async function initSQLite() { // Added
  log.info("Initializing SQLite user store...");
  initSQLiteDB(); // Initialize the DB connection and schema
  await loadUsersFromSQLite();
  // Set up periodic flush for SQLite, similar to Firebase
  sqliteInterval = setInterval(flushUsersToSQLite, 20 * 1000);
  log.info("SQLite user store initialized and users loaded.");
}

async function initFirebase() {
  log.info("Connecting to Firebase...");
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref(USERS_REF);
  const snapshot = await usersRef.once("value");
  const usersData: Record<string, any> | null = snapshot.val(); // Store as 'any' initially for migration
  firebaseTimeout = setInterval(flushUsers, 20 * 1000);

  if (!usersData) {
    log.info("No users found in Firebase.");
    return;
  }

  // migrateTokenCountsProperty is now defined at module scope

  for (const token in usersData) {
    const rawUser = usersData[token];
    const migratedUser: User = {
      ...rawUser, // Spread existing fields
      token: rawUser.token || token, // Ensure token is present
      ip: rawUser.ip || [],
      type: rawUser.type || "normal",
      promptCount: rawUser.promptCount || 0,
      createdAt: rawUser.createdAt || Date.now(),
      // Migrate token fields
      tokenCounts: migrateTokenCountsProperty(rawUser.tokenCounts, INITIAL_TOKENS),
      tokenLimits: migrateTokenLimitsProperty(rawUser.tokenLimits, config.tokenQuota),
      tokenRefresh: migrateTokenLimitsProperty(rawUser.tokenRefresh, config.tokenQuota),
      meta: rawUser.meta || {},
    };
    // Use the internal map directly to avoid re-triggering upsertUser's default creations
    users.set(token, migratedUser);
  }
  usersToFlush.clear(); // Clear flush queue after initial load and migration
  const numUsers = Object.keys(usersData).length;
  log.info({ users: numUsers }, "Loaded and migrated users from Firebase");
}

async function flushUsers() {
  const app = getFirebaseApp();
  const db = admin.database(app);
  const usersRef = db.ref(USERS_REF);
  const updates: Record<string, User> = {};
  const deletions = [];

  for (const token of usersToFlush) {
    const user = users.get(token);
    if (!user) {
      deletions.push(token);
      continue;
    }
    updates[token] = user;
  }

  usersToFlush.clear();

  const numUpdates = Object.keys(updates).length + deletions.length;
  if (numUpdates === 0) {
    return;
  }

  await usersRef.update(updates);
  await Promise.all(deletions.map((token) => usersRef.child(token).remove()));
  log.info(
    { users: Object.keys(updates).length, deletions: deletions.length },
    "Flushed changes to Firebase"
  );
}

async function loadUsersFromSQLite() { // Added
  log.info("Loading users from SQLite...");
  const db = getDB();
  const rows = db.prepare("SELECT * FROM users").all() as any[];
  for (const row of rows) {
    const rawTokenCounts = row.tokenCounts ? JSON.parse(row.tokenCounts) : null;
    const rawTokenLimits = row.tokenLimits ? JSON.parse(row.tokenLimits) : null;
    const rawTokenRefresh = row.tokenRefresh ? JSON.parse(row.tokenRefresh) : null;

    const user: User = {
      token: row.token,
      ip: row.ip ? JSON.parse(row.ip) : [],
      nickname: row.nickname,
      type: row.type,
      promptCount: row.promptCount,
      tokenCounts: migrateTokenCountsProperty(rawTokenCounts, INITIAL_TOKENS),
      tokenLimits: migrateTokenLimitsProperty(rawTokenLimits, config.tokenQuota),
      tokenRefresh: migrateTokenLimitsProperty(rawTokenRefresh, config.tokenQuota),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      disabledAt: row.disabledAt,
      disabledReason: row.disabledReason,
      expiresAt: row.expiresAt,
      maxIps: row.maxIps,
      adminNote: row.adminNote,
      meta: row.meta ? JSON.parse(row.meta) : {},
    };
    users.set(user.token, user);
  }
  usersToFlush.clear(); // Clear flush queue after initial load
  log.info({ users: users.size }, "Loaded users from SQLite.");
}

async function flushUsersToSQLite() { // Added
  if (flushingToSQLiteInProgress) {
    log.trace("Flush to SQLite already in progress, skipping.");
    return;
  }
  if (usersToFlush.size === 0) {
    return;
  }

  flushingToSQLiteInProgress = true;
  log.trace({ count: usersToFlush.size }, "Starting flush to SQLite.");

  const db = getDB();
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO users (
      token, ip, nickname, type, promptCount, tokenCounts, tokenLimits,
      tokenRefresh, createdAt, lastUsedAt, disabledAt, disabledReason,
      expiresAt, maxIps, adminNote, meta
    ) VALUES (
      @token, @ip, @nickname, @type, @promptCount, @tokenCounts, @tokenLimits,
      @tokenRefresh, @createdAt, @lastUsedAt, @disabledAt, @disabledReason,
      @expiresAt, @maxIps, @adminNote, @meta
    )
  `);
  const deleteStmt = db.prepare("DELETE FROM users WHERE token = ?");

  let updatedCount = 0;
  let deletedCount = 0;

  const transaction = db.transaction(() => {
    for (const token of usersToFlush) {
      const user = users.get(token);
      if (user) {
        insertStmt.run({
          token: user.token,
          ip: JSON.stringify(user.ip || []),
          nickname: user.nickname ?? null,
          type: user.type,
          promptCount: user.promptCount,
          tokenCounts: JSON.stringify(user.tokenCounts || INITIAL_TOKENS),
          tokenLimits: JSON.stringify(user.tokenLimits || migrateTokenLimitsProperty(null, config.tokenQuota)),
          tokenRefresh: JSON.stringify(user.tokenRefresh || migrateTokenLimitsProperty(null, config.tokenQuota)),
          createdAt: user.createdAt,
          lastUsedAt: user.lastUsedAt ?? null,
          disabledAt: user.disabledAt ?? null,
          disabledReason: user.disabledReason ?? null,
          expiresAt: user.expiresAt ?? null,
          maxIps: user.maxIps ?? null,
          adminNote: user.adminNote ?? null,
          meta: JSON.stringify(user.meta || {}),
        });
        updatedCount++;
      } else {
        // User was deleted from in-memory map
        deleteStmt.run(token);
        deletedCount++;
      }
    }
  });

  try {
    transaction();
    usersToFlush.clear();
    if (updatedCount > 0 || deletedCount > 0) {
      log.info({ updated: updatedCount, deleted: deletedCount }, "Flushed user changes to SQLite.");
    }
  } catch (error: any) {
    log.error({
        message: error?.message || "Unknown error during SQLite flush",
        stack: error?.stack,
        code: error?.code, // SQLite errors often have a code
        rawError: error // Log the raw error object for more details
    }, "Error flushing users to SQLite.");
    // Re-add tokens to flush queue if transaction failed, so we can retry
    // This is a simplistic retry, might need more robust error handling
    // Ensure usersToFlush still contains the tokens that failed to process
    // The current logic inside the transaction means usersToFlush is cleared only on success.
    // If transaction fails, usersToFlush would still contain the items from before the attempt.
    // However, if items were added to usersToFlush *during* the failed transaction,
    // they would be processed in the next attempt.
    // For simplicity, the current re-add logic is okay, but could be refined if specific
    // tokens fail consistently.
    usersToFlush.forEach(token => usersToFlush.add(token));
  } finally {
    flushingToSQLiteInProgress = false;
    log.trace("Finished flush to SQLite attempt.");
  }
}

function getModelFamilyForQuotaUsage(
  model: string,
  api: APIFormat
): ModelFamily {
  // "azure" here is added to model names by the Azure key provider to
  // differentiate between Azure and OpenAI variants of the same model.
  if (model.includes("azure")) return getAzureOpenAIModelFamily(model);
  if (model.includes("anthropic.")) return getAwsBedrockModelFamily(model);
  if (model.startsWith("claude-") && model.includes("@"))
    return getGcpModelFamily(model);
  if (model.startsWith("deepseek")) return "deepseek";
  if (model.startsWith("grok-")) return "xai";
  if (model.startsWith("kimi")) return "moonshot";
  if (model.startsWith("qwen")) return "qwen";
  if (model.startsWith("glm")) return "glm";
  if (model.includes("openrouter")) return getOpenRouterModuleFamily(model);

  switch (api) {
    case "openai":
    case "openai-text":
    case "openai-responses":
    case "openai-image":
      return getOpenAIModelFamily(model);
    case "anthropic-chat":
    case "anthropic-text":
      return getClaudeModelFamily(model);
    case "google-ai":
      return getGoogleAIModelFamily(model);
    case "mistral-ai":
    case "mistral-text":
      return getMistralAIModelFamily(model);
    default:
      assertNever(api);
  }
}

function getRefreshCrontab() {
  switch (config.quotaRefreshPeriod!) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return "0 0 * * *";
    default:
      return config.quotaRefreshPeriod ?? "0 0 * * *";
  }
}
