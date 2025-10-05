import crypto from "crypto";
import { logger } from "../../logger";

/**
 * Deterministic JSON stringify that sorts object keys to ensure consistent hashing.
 */
function deterministicStringify(obj: any): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(deterministicStringify).join(",")}]`;

  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => `"${k}":${deterministicStringify(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * Universal cache tracker for all providers (Anthropic, AWS, GCP).
 *
 * Tracks which keys have cached which prompt prefixes to optimize prompt caching.
 * Each API key has its own cache, so routing requests with identical cacheable
 * content to the same key maximizes cache hits.
 *
 * Cache rules (per Anthropic/Bedrock/Vertex docs):
 * - 100% identical prompt segments required for cache hit
 * - Default 5-minute TTL, refreshed on each use
 * - Optional 1-hour TTL
 * - Cache becomes available after first response begins
 * - Minimum 1024-2048 tokens (model-dependent)
 */

interface CacheEntry {
  keyHash: string;
  lastUsed: number;
  hitCount: number;
  ttl: number;
  // Store all prefix fingerprints for hierarchical matching
  prefixFingerprints?: string[];
}

const log = logger.child({ module: "cache-tracker" });

// Maps cache fingerprints to the key that has cached that content
const cacheMap = new Map<string, CacheEntry>();

// Default TTLs in milliseconds
const TTL_5_MINUTES = 5 * 60 * 1000;
const TTL_1_HOUR = 60 * 60 * 1000;

/**
 * Generates a fingerprint for cacheable content in a request.
 * The fingerprint includes content up to and including the LAST cache_control
 * breakpoint, following Anthropic's hierarchy: tools → system → messages.
 *
 * Key insight for handling ever-growing prompts:
 * By fingerprinting only up to the last cache_control marker, we ensure that
 * new content added AFTER that marker (e.g., new user messages in a conversation)
 * won't change the fingerprint. This enables cache hits as conversations grow.
 *
 * How Anthropic's cache matching works:
 * - You place ONE cache_control at the end of your static/stable content
 * - The API automatically checks ~20 blocks BEFORE that breakpoint for cache hits
 * - It uses the longest matching prefix automatically
 * - You don't need multiple breakpoints - one at the end is sufficient
 *
 * Example conversation flow:
 * Request 1: [system prompt + cache_control] → Creates cache, fingerprint = "abc123"
 * Request 2: [system prompt + cache_control] + [user msg] + [assistant msg] + [user msg]
 *            → Same fingerprint "abc123" → Cache HIT (new messages after breakpoint ignored)
 * Request 3: [MODIFIED system prompt + cache_control] + messages
 *            → Different fingerprint "def456" → Cache MISS (prefix changed)
 */
export function generateCacheFingerprint(body: any): string | null {
  if (!body) {
    return null;
  }

  const parts: any[] = [];
  let hasCacheControl = false;
  const cacheBreakpoints: number[] = []; // Indices of cache_control markers
  const ttls: number[] = []; // TTL for each breakpoint

  // 1. Process tools if present (tools come first in hierarchy)
  if (body.tools && Array.isArray(body.tools)) {
    for (let i = 0; i < body.tools.length; i++) {
      const tool = body.tools[i];
      // Only include the stable parts of the tool definition in the fingerprint
      // Exclude cache_control as it's metadata, not part of the tool definition
      const { cache_control, ...toolWithoutCache } = tool;
      parts.push({ type: "tool", tool: toolWithoutCache });
      if (cache_control) {
        hasCacheControl = true;
        cacheBreakpoints.push(parts.length - 1);
        ttls.push(parseTTL(cache_control.ttl));
      }
    }
  }

  // 2. Process system prompt if present
  if (body.system) {
    if (typeof body.system === "string") {
      // Normalize string system to same structure as array blocks for consistent fingerprinting
      parts.push({ type: "system_block", block_type: "text", text: body.system });
    } else if (Array.isArray(body.system)) {
      for (const block of body.system) {
        // System blocks can be:
        // - {type: "text", text: "...", cache_control?: ...}
        // - {type: "image", source: {...}, cache_control?: ...}
        const { cache_control, type, ...rest } = block;

        // Create a consistent fingerprint structure
        const contentPart: any = { type: "system_block", block_type: type };

        switch (type) {
          case "text":
            contentPart.text = (rest as any).text;
            break;
          case "image":
            // Hash image data for fingerprint
            if ((rest as any).source?.data) {
              contentPart.image_hash = crypto
                .createHash("sha256")
                .update((rest as any).source.data)
                .digest("hex")
                .slice(0, 16);
            }
            contentPart.media_type = (rest as any).source?.media_type;
            break;
          default:
            // For unknown block types, include all remaining fields
            Object.assign(contentPart, rest);
        }

        parts.push(contentPart);

        if (cache_control) {
          hasCacheControl = true;
          cacheBreakpoints.push(parts.length - 1);
          ttls.push(parseTTL(cache_control.ttl));
        }
      }
    }
  }

  // 3. Process messages
  if (body.messages && Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (typeof message.content === "string") {
        parts.push({
          type: "message",
          role: message.role,
          content: message.content,
        });
      } else if (Array.isArray(message.content)) {
        // For multimodal content, include each block
        for (const block of message.content) {
          // CRITICAL: Exclude cache_control metadata from fingerprinting
          // Only the actual content should affect the fingerprint
          const { cache_control, ...blockWithoutCache } = block;

          const contentPart: any = {
            type: "message_block",
            role: message.role,
            block_type: blockWithoutCache.type,
          };

          // Include essential identifying info without full data
          // (full data would make fingerprints too large)
          switch (blockWithoutCache.type) {
            case "text":
              contentPart.text = blockWithoutCache.text;
              break;
            case "image":
              // Hash image data for fingerprint
              if (blockWithoutCache.source?.data) {
                contentPart.image_hash = crypto
                  .createHash("sha256")
                  .update(blockWithoutCache.source.data)
                  .digest("hex")
                  .slice(0, 16);
              }
              contentPart.media_type = blockWithoutCache.source?.media_type;
              break;
            case "tool_use":
              // Don't include tool_id as it's often randomly generated
              // Only include tool name and input which are stable
              contentPart.tool_name = blockWithoutCache.name;
              contentPart.tool_input = blockWithoutCache.input;
              break;
            case "tool_result":
              // Don't include tool_use_id as it's randomly generated
              // Only include the actual result content and error status
              contentPart.is_error = blockWithoutCache.is_error;
              if (typeof blockWithoutCache.content === "string") {
                contentPart.content = blockWithoutCache.content;
              } else if (Array.isArray(blockWithoutCache.content)) {
                // tool_result content can be an array of content blocks
                contentPart.content = blockWithoutCache.content;
              }
              break;
          }

          parts.push(contentPart);

          if (cache_control) {
            hasCacheControl = true;
            cacheBreakpoints.push(parts.length - 1);
            ttls.push(parseTTL(cache_control.ttl));
          }
        }
      }
    }
  }

  // No caching if no cache_control directives present
  if (!hasCacheControl || cacheBreakpoints.length === 0) {
    return null;
  }

  const maxTTL = Math.max(...ttls);

  // Generate individual hashes for each part (tool, system block, message)
  // This allows prefix matching even when conversations grow
  const partHashes: string[] = [];
  for (const part of parts) {
    const partHash = crypto
      .createHash("sha256")
      .update(deterministicStringify(part))
      .digest("hex")
      .slice(0, 8); // Shorter hash per part
    partHashes.push(partHash);
  }

  // Generate fingerprints for each cache_control position
  // Fingerprint is the concatenation of individual part hashes up to the breakpoint
  const prefixFingerprints: string[] = [];

  for (const breakpoint of cacheBreakpoints) {
    // Concatenate part hashes up to and including the breakpoint
    const fingerprint = partHashes.slice(0, breakpoint + 1).join("");

    log.trace(
      {
        fingerprint: fingerprint.substring(0, 32) + "...",
        breakpoint,
        prefixPartsCount: breakpoint + 1,
      },
      "Generated cache fingerprint"
    );

    prefixFingerprints.push(fingerprint);
  }

  // Return the deepest (last) fingerprint as the primary one
  const primaryFingerprint = prefixFingerprints[prefixFingerprints.length - 1];

  // Store ALL prefix fingerprints in the cache map, not just the primary one
  // This allows future requests to match against any prefix level
  for (let i = 0; i < prefixFingerprints.length; i++) {
    const fp = prefixFingerprints[i];
    const existing = cacheMap.get(fp);

    if (!existing) {
      cacheMap.set(fp, {
        keyHash: "",
        lastUsed: 0,
        hitCount: 0,
        ttl: maxTTL,
        prefixFingerprints: prefixFingerprints.slice(0, i + 1),
      });
    }
  }

  return primaryFingerprint;
}

function parseTTL(ttl?: string): number {
  if (ttl === "1h") return TTL_1_HOUR;
  return TTL_5_MINUTES; // Default or "5m"
}

/**
 * Records that a key was used for a request with the given cache fingerprint.
 */
export function recordCacheUsage(fingerprint: string, keyHash: string): void {
  if (!fingerprint) return;

  const entry = cacheMap.get(fingerprint);
  if (!entry) {
    // Shouldn't happen, but handle gracefully
    cacheMap.set(fingerprint, {
      keyHash,
      lastUsed: Date.now(),
      hitCount: 1,
      ttl: TTL_5_MINUTES,
    });
    log.trace({ fingerprint: fingerprint.substring(0, 32) + "...", keyHash }, "New cache entry recorded");
    return;
  }

  const now = Date.now();

  if (entry.keyHash === keyHash) {
    // Same key - likely cache hit
    entry.lastUsed = now;
    entry.hitCount++;
    log.trace(
      { fingerprint: fingerprint.substring(0, 32) + "...", keyHash, hitCount: entry.hitCount },
      "Cache usage recorded (likely cache hit)"
    );
  } else if (entry.keyHash === "") {
    // First use of this fingerprint
    entry.keyHash = keyHash;
    entry.lastUsed = now;
    entry.hitCount = 1;
    log.debug({ fingerprint: fingerprint.substring(0, 32) + "...", keyHash }, "First cache usage for fingerprint");
  } else {
    // Different key - cache miss, reset tracking
    log.debug(
      { fingerprint: fingerprint.substring(0, 32) + "...", oldKey: entry.keyHash, newKey: keyHash },
      "Cache key changed (will cause cache miss)"
    );
    entry.keyHash = keyHash;
    entry.lastUsed = now;
    entry.hitCount = 1;
  }
}

/**
 * Gets the key hash that has cached the longest matching prefix for the given
 * fingerprint or any of its sub-prefixes.
 *
 * This is crucial for handling moving cache breakpoints:
 * - If the current request has fingerprints ["fp1", "fp2", "fp3"]
 * - We search backwards from "fp3" → "fp2" → "fp1"
 * - Return the key that cached the longest available prefix
 *
 * Returns null if no cached key exists or all caches have expired.
 */
export function getCachedKeyHash(fingerprint: string): { keyHash: string; matchedFingerprint: string } | null {
  if (!fingerprint) return null;

  const now = Date.now();

  // First, try exact match on the primary (deepest) fingerprint
  const primaryEntry = cacheMap.get(fingerprint);
  if (primaryEntry && primaryEntry.keyHash) {
    const age = now - primaryEntry.lastUsed;
    if (age <= primaryEntry.ttl) {
      log.trace(
        {
          fingerprint: fingerprint.substring(0, 32) + "...",
          keyHash: primaryEntry.keyHash,
          age,
          hitCount: primaryEntry.hitCount,
          matchType: "exact",
        },
        "Cache entry found (exact match)"
      );
      return { keyHash: primaryEntry.keyHash, matchedFingerprint: fingerprint };
    } else {
      log.trace({ fingerprint: fingerprint.substring(0, 32) + "...", age, ttl: primaryEntry.ttl }, "Cache entry expired");
      cacheMap.delete(fingerprint);
    }
  }

  // If no exact match, search all cache entries for prefix matches
  // Since fingerprints are now concatenated part hashes, we can check if one is a prefix of another
  let bestMatch: { keyHash: string; matchedFingerprint: string } | null = null;
  let longestMatchLength = 0;

  for (const [cachedFp, entry] of cacheMap.entries()) {
    if (!entry.keyHash) continue;

    const age = now - entry.lastUsed;
    if (age > entry.ttl) {
      cacheMap.delete(cachedFp);
      continue;
    }

    // Check if the cached fingerprint is a prefix of the current fingerprint
    // (cached request had fewer parts, current request has grown)
    if (fingerprint.startsWith(cachedFp) && cachedFp.length > longestMatchLength) {
      bestMatch = { keyHash: entry.keyHash, matchedFingerprint: cachedFp };
      longestMatchLength = cachedFp.length;
      log.trace(
        {
          requestFingerprint: fingerprint.substring(0, 32) + "...",
          matchedFingerprint: cachedFp.substring(0, 32) + "...",
          keyHash: entry.keyHash,
          matchType: "prefix",
        },
        "Cache entry found (prefix match)"
      );
    }

    // Also check if the current fingerprint is a prefix of the cached one
    // (current request has fewer parts, cached had more)
    if (cachedFp.startsWith(fingerprint) && fingerprint.length > longestMatchLength) {
      bestMatch = { keyHash: entry.keyHash, matchedFingerprint: cachedFp };
      longestMatchLength = fingerprint.length;
      log.trace(
        {
          requestFingerprint: fingerprint.substring(0, 32) + "...",
          matchedFingerprint: cachedFp.substring(0, 32) + "...",
          keyHash: entry.keyHash,
          matchType: "prefix_reverse",
        },
        "Cache entry found (reverse prefix match)"
      );
    }
  }

  return bestMatch || null;
}

/**
 * Clears expired cache entries periodically to prevent memory leaks.
 */
export function cleanupExpiredCaches(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [fingerprint, entry] of cacheMap.entries()) {
    const age = now - entry.lastUsed;
    if (age > entry.ttl) {
      cacheMap.delete(fingerprint);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log.debug(
      { cleaned, remaining: cacheMap.size },
      "Cleaned up expired cache entries"
    );
  }
}

/**
 * Returns cache statistics for monitoring.
 */
export function getCacheStats() {
  return {
    totalEntries: cacheMap.size,
    entries: Array.from(cacheMap.entries()).map(([fp, entry]) => ({
      fingerprint: fp,
      keyHash: entry.keyHash,
      age: Date.now() - entry.lastUsed,
      hitCount: entry.hitCount,
      ttl: entry.ttl,
    })),
  };
}

// Run cleanup every minute
setInterval(cleanupExpiredCaches, 60 * 1000);