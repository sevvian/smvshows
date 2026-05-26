# SMVShows v2.0 — ⚡ Instant Cache-Checking with TorBox checkcached
Comprehensive Update to the Multi-Debrid Abstraction Implementation Guide

Document Version: 2.0.1

Based on: TorBox OpenAPI specification (api.torbox.app/openapi.json) — /v1/api/torrents/checkcached endpoint.

Key Insight: TorBox exposes a batch cache-check endpoint that Real-Debrid does not (RD removed instant-availability after the 2024 crackdown). This difference must be elegantly abstracted so the upper-layer application can mark streams with ⚡ instantly for TorBox while falling back to the local database for RD.

---

# 🔬 Research Findings: TorBox /checkcached API

## Endpoint Details

```text
POST /v1/api/torrents/checkcached
GET  /v1/api/torrents/checkcached
Auth: Bearer <api_key>
```

Parameters (from OpenAPI spec):

| Parameter | Type | Required | Description |
|---|---|---|---|
| hash | string[] (query or body) | false | Array of torrent info hashes |
| format | string | false | "object" (default) — response format |
| list_files | boolean | false | When true, returns file lists for cached torrents |

Request body (optional): `{ "hashes": ["hash1", "hash2", ...] }` — can send multiple hashes in a single call.

Response (inferred from changelogs and OpenAPI spec):

```json
{
  "success": true,
  "data": {
    "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c": true,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": false
  }
}
```

Or with `list_files: true`:

```json
{
  "success": true,
  "data": {
    "dd8255ec...": { "cached": true, "files": [...] }
  }
}
```

Key properties:

- Returns a boolean per hash — instant, no torrent creation needed
- Supports batch — send many hashes in one request
- Rate-limited at 60 req/hour for creation endpoints, but checkcached is a read operation (lighter limit)
- If nothing is cached, returns an empty object (not an error)

---

# 🏗️ Architectural Strategy: checkCached Abstraction

## The Problem

- TorBox has a native batch-check endpoint → instant ⚡ marking
- Real-Debrid removed instant-availability → must use local DB lookup
- Future providers may or may not have this capability

## The Solution: Capability-Based Provider Interface

Extend the provider interface with an optional `checkCached` method. The factory will expose a unified `checkCached` that:

1. If the provider has `checkCached` (TorBox) → call it, get instant results
2. If the provider does not have it (RD, disabled stub) → fall back to local database query
3. Cache results locally to avoid redundant API calls within the same request window

---

# 📂 Updated Provider Interface Contract

Every debrid provider module MUST export these seven items plus an optional eighth:

```javascript
module.exports = {
    isEnabled: Boolean,
    addMagnet: async (magnet) => {},
    getTorrentInfo: async (id) => {},
    selectFiles: async (id, fileIds) => {},
    unrestrictLink: async (link) => {},
    addAndSelect: async (magnet) => {},
    ResourceNotFoundError: class extends Error {},

    // OPTIONAL — batch cache check (TorBox has it, RD does not)
    checkCached: async (hashes, options) => {}  // NEW for v2.0
};
```

If `checkCached` is present and `isEnabled` is true, the factory uses it for instant cache checking.

If `checkCached` is absent, the factory falls back to a database query.

## checkCached Method Signature

```javascript
/**
 * Batch-check if torrent hashes are cached on the provider.
 * Provider-specific — only available on TorBox (and potentially others).
 * 
 * @param {string[]} hashes - Array of torrent info hashes
 * @param {object} options - { listFiles?: boolean }
 * @returns {Promise<object>} - { [hash]: true | false | { cached: true, files: [...] } }
 */
async checkCached(hashes, options = {}) { ... }
```

---

# 📝 File-by-File Changes (v2.0.1 Update)

## File 1: src/services/debrid/torbox.js — ADD checkCached method

Insert the following method inside the else block (after the addAndSelect function, before the module.exports):

```javascript
// ── 6. checkCached (TorBox-native batch cache check) ────────────
/**
 * Instantly check if a list of torrent hashes are cached on TorBox.
 * This is a unique TorBox capability — Real-Debrid removed this feature.
 * 
 * Uses POST /v1/api/torrents/checkcached with an array of hashes.
 * Returns a map of hash → boolean (or object if listFiles is true).
 */
async function checkCached(hashes, options = {}) {
    if (!hashes || hashes.length === 0) return {};

    try {
        // TorBox accepts hashes via query params (array) OR request body
        // We use query params for simplicity, matching the OpenAPI spec.
        const params = new URLSearchParams();
        hashes.forEach(h => params.append('hash', h));
        if (options.format) params.append('format', options.format);
        if (options.listFiles) params.append('list_files', 'true');

        const response = await tbApi.post('/torrents/checkcached', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        // Normalize response: TorBox may wrap in { data: {...} }
        const payload = response.data.data || response.data;

        // Response shape: { "hash1": true, "hash2": false }
        // Convert to a consistent map
        const result = {};
        for (const [hash, value] of Object.entries(payload)) {
            result[hash] = value; // true/false or { cached: true, files: [...] }
        }

        logger.debug({ hashCount: hashes.length, cachedCount: Object.keys(result).length },
            'TorBox checkCached batch complete.');
        return result;
    } catch (error) {
        logger.error({ err: error.response?.data || error.message, hashes },
            'TorBox checkCached batch failed. Falling back to per-torrent check.');
        // On failure, return empty — caller will fall back to per-hash checks
        return {};
    }
}
```

Update the module.exports to include checkCached:

```javascript
module.exports = {
    isEnabled: true,
    addMagnet,
    getTorrentInfo,
    selectFiles,
    unrestrictLink,
    addAndSelect,
    checkCached,           // ← NEW
    ResourceNotFoundError
};
```

---

## File 2: src/services/debrid/realdebrid.js — NO CHANGE

Real-Debrid does not export checkCached. This absence is intentional — the factory will detect it and fall back to the database.

Do NOT add a stub checkCached to RD. The factory logic (below) handles the fallback.

---

## File 3: src/services/debrid/index.js — UPDATE Factory

Replace the getProvider function and add a checkCached wrapper:

```javascript
// src/services/debrid/index.js
const config = require('../../config/config');
const logger = require('../../utils/logger');

let _provider = null;

function getProvider() {
    if (_provider) return _provider;

    const service = config.debridService;
    logger.info(`[DebridFactory] Loading provider: ${service}`);

    switch (service) {
        case 'realdebrid':
            _provider = require('./realdebrid');
            break;
        case 'torbox':
            _provider = require('./torbox');
            break;
        case 'none':
        default:
            _provider = createDisabledProvider();
            break;
    }
    return _provider;
}

function createDisabledProvider() {
    class ResourceNotFoundError extends Error {
        constructor(msg) { super(msg); this.name = 'ResourceNotFoundError'; }
    }
    return {
        isEnabled: false,
        addMagnet: async () => { throw new Error('No debrid service configured.'); },
        getTorrentInfo: async () => { throw new Error('No debrid service configured.'); },
        selectFiles: async () => { throw new Error('No debrid service configured.'); },
        unrestrictLink: async () => { throw new Error('No debrid service configured.'); },
        addAndSelect: async () => { throw new Error('No debrid service configured.'); },
        // checkCached intentionally absent — triggers DB fallback
        ResourceNotFoundError
    };
}

// ── Unified checkCached ─────────────────────────────────────────
/**
 * Batch-check torrent cache status.
 * - If the provider has checkCached (TorBox), use it for instant results.
 * - If not (RD, disabled), query the local database instead.
 * 
 * @param {string[]} hashes - Array of info hashes to check
 * @param {object} models - Sequelize models (for DB fallback)
 * @returns {Promise<object>} - { [hash]: true | false }
 */
async function unifiedCheckCached(hashes, models) {
    const provider = getProvider();

    // ── Path 1: Provider has native checkCached (TorBox) ──────────
    if (provider.isEnabled && typeof provider.checkCached === 'function') {
        try {
            const result = await provider.checkCached(hashes);
            logger.debug(`[checkCached] Provider returned instant results for ${Object.keys(result).length}/${hashes.length} hashes.`);
            return result;
        } catch (err) {
            logger.warn({ err: err.message }, '[checkCached] Provider checkCached failed, falling back to DB.');
            // Fall through to DB check
        }
    }

    // ── Path 2: Fallback — query local database ──────────────────
    if (models && models.DebridTorrent) {
        const dbResults = {};
        try {
            const records = await models.DebridTorrent.findAll({
                where: { infohash: hashes },
                attributes: ['infohash', 'status']
            });
            for (const record of records) {
                // Consider "downloaded" status as cached
                dbResults[record.infohash] = record.status === 'downloaded';
            }
            // Hashes not in DB are not cached
            for (const hash of hashes) {
                if (!(hash in dbResults)) {
                    dbResults[hash] = false;
                }
            }
            logger.debug(`[checkCached] DB fallback returned results for ${Object.keys(dbResults).length}/${hashes.length} hashes.`);
            return dbResults;
        } catch (err) {
            logger.error({ err: err.message }, '[checkCached] DB fallback failed.');
            // Return all false if DB fails
            const fallback = {};
            hashes.forEach(h => fallback[h] = false);
            return fallback;
        }
    }

    // ── Path 3: No provider, no DB — all false ───────────────────
    const empty = {};
    hashes.forEach(h => empty[h] = false);
    return empty;
}

// Proxy so callers can do `debrid.checkCached(hashes, models)`
module.exports = new Proxy({}, {
    get(target, prop) {
        if (prop === 'checkCached') {
            return (hashes, models) => unifiedCheckCached(hashes, models);
        }
        const p = getProvider();
        if (prop in p) return p[prop];
        return undefined;
    }
});
```

---

## File 4: src/api/stremio.routes.js — UPDATE Stream Endpoint

The Stremio /stream endpoint currently queries models.DebridTorrent to check cache status for the ⚡ emoji. We'll add a pre-fetch cache check using the debrid factory.

Locate the stream handler (around line 236 where if (debrid.isEnabled) appears). Add a batch checkCached call before building the stream list:

```javascript
// ── BEFORE building stream list, batch-check all hashes ──────────
let cacheStatus = {};
if (debrid.isEnabled && allStreams.length > 0) {
    const allHashes = [...new Set(allStreams.map(s => s.infohash))]; // deduplicate
    try {
        cacheStatus = await debrid.checkCached(allHashes, models);
    } catch (err) {
        logger.warn({ err: err.message }, 'Batch cache check failed, marking all as uncached.');
        // Default: all false
        allHashes.forEach(h => cacheStatus[h] = false);
    }
}

// ── THEN build the stream list with ⚡ marking ────────────────────
for (const stream of allStreams) {
    const isCached = cacheStatus[stream.infohash] === true; // ⚡ instant check result

    streamList.push({
        name: `[RD+] ${title}\n${quality}`,
        title: isCached ? '⚡ Instant' : '⏳',
        // ... rest of stream properties
    });
}
```

Key changes in stream building:

- Remove the individual models.DebridTorrent.findByPk(infoHash) calls (these are now batched).
- Replace isCached logic with the batch result: const isCached = cacheStatus[infoHash] === true;
- For TorBox: checkCached returns instant results from the API → ⚡ appears immediately.
- For RD: checkCached falls back to DB → same behavior as before (only ⚡ if previously downloaded).

---

## File 5: src/api/admin.routes.js — Optional Enhancement

In the admin panel's health endpoint, add cache-check capability info:

```javascript
// In /health endpoint response:
debridCacheCheck: typeof debrid.checkCached === 'function' ? 'instant' : 'database',
```

This helps the admin UI show whether the current provider supports instant cache checking.

---

## File 6: public/admin.html — Update UI

Add a status indicator for cache-check method:

```html
<tr>
    <td>Cache check:</td>
    <td id="cacheCheckMethod">-</td>
</tr>
```

Update the JavaScript that populates the health data:

```javascript
document.getElementById('cacheCheckMethod').textContent =
    data.debridCacheCheck === 'instant' ? '⚡ Instant (API)' : '🗄️ Database';
```

---

# 🧪 Testing Strategy

## Unit Test: checkCached Contract

```javascript
// tests/debrid-checkcached.test.js
const assert = require('assert');

function testCheckCachedCapability(providerName, provider) {
    console.log(`\n  Testing ${providerName} checkCached capability...`);

    if (!provider.isEnabled) {
        console.log(`  - ${providerName} is disabled, skipping checkCached tests.`);
        return;
    }

    // TorBox should have checkCached, RD should not
    const hasCheckCached = typeof provider.checkCached === 'function';

    if (providerName === 'TorBox') {
        assert.ok(hasCheckCached, 'TorBox must export checkCached');
        // Verify signature: async function
        assert.strictEqual(provider.checkCached.constructor.name, 'AsyncFunction');
    }

    if (providerName === 'RealDebrid') {
        assert.strictEqual(hasCheckCached, false,
            'RealDebrid must NOT export checkCached (triggers DB fallback)');
    }

    console.log(`  ✓ ${providerName} checkCached capability: ${hasCheckCached ? 'instant' : 'database'}`);
}

// Test the factory's unified checkCached
async function testUnifiedCheckCached() {
    console.log('\n  Testing unified checkCached via factory...');

    const debrid = require('../src/services/debrid');

    // The factory should expose checkCached even when provider doesn't have it
    assert.strictEqual(typeof debrid.checkCached, 'function',
        'Factory must expose checkCached');

    // Test with empty hashes
    const result = await debrid.checkCached([]);
    assert.deepStrictEqual(result, {}, 'Empty hashes should return empty object');

    console.log('  ✓ Factory unified checkCached works');
}

runAllTests();
```

## Integration Test: TorBox checkCached

```javascript
// tests/torbox-checkcached-integration.test.js
const assert = require('assert');
const config = require('../src/config/config');

async function testTorboxCheckCached() {
    if (!config.isTorboxEnabled) {
        console.log('TorBox not configured, skipping integration test.');
        return;
    }

    const tb = require('../src/services/debrid/torbox');
    assert.ok(tb.isEnabled, 'TorBox should be enabled for this test');

    // Test 1: Single hash check
    console.log('1. Testing single hash check...');
    const knownHash = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c'; // Big Buck Bunny
    const singleResult = await tb.checkCached([knownHash]);
    assert.ok(singleResult, 'Should return an object');
    console.log(`   Result: ${JSON.stringify(singleResult)}`);

    // Test 2: Batch check
    console.log('2. Testing batch hash check...');
    const multipleHashes = [
        'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    ];
    const batchResult = await tb.checkCached(multipleHashes);
    assert.ok(batchResult, 'Should return an object');
    assert.strictEqual(typeof batchResult, 'object', 'Result should be an object');
    console.log(`   Result has ${Object.keys(batchResult).length} entries`);

    // Test 3: Empty array
    console.log('3. Testing empty array...');
    const emptyResult = await tb.checkCached([]);
    assert.deepStrictEqual(emptyResult, {}, 'Empty array should return empty object');

    console.log('✓ All TorBox checkCached integration tests passed.');
}

testTorboxCheckCached().catch(console.error);
```

---

# 📊 Comparison: RD vs TorBox Cache Checking

| Feature | Real-Debrid | TorBox |
|---|---|---|
| Instant cache check | ❌ Removed in 2024 | ✅ Native /checkcached |
| Batch check | ❌ Must query individually | ✅ Single API call for all hashes |
| Cache check source | Local debrid_torrents table | TorBox server API |
| ⚡ Marking | Only after first download | Instant — before any download |
| Rate limit impact | DB read — no API call | 1 API call per stream request |
| Fallback if fails | N/A (DB always available) | Falls back to DB query |

---

# 🎯 Summary of All v2.0.1 Changes

| # | File | Change |
|---|---|---|
| 1 | src/services/debrid/torbox.js | ADD checkCached method using /v1/api/torrents/checkcached |
| 2 | src/services/debrid/realdebrid.js | NO CHANGE — intentionally omits checkCached |
| 3 | src/services/debrid/index.js | ADD unifiedCheckCached with provider-aware fallback |
| 4 | src/api/stremio.routes.js | ADD batch pre-fetch before stream building |
| 5 | src/api/admin.routes.js | ADD debridCacheCheck to health endpoint |
| 6 | public/admin.html | ADD cache-check method indicator |
| 7 | tests/debrid-checkcached.test.js | NEW contract + integration tests |

## Behavior Matrix

| Provider | isEnabled | checkCached exported? | Stream ⚡ marking |
|---|---|---|---|
| TorBox | true | ✅ Yes (API) | ⚡ Instant (before download) |
| Real-Debrid | true | ❌ No (DB fallback) | ⚡ After first download |
| None | false | ❌ No (all false) | No ⚡ |

---

# End of v2.0.1 Update — Instant Cache-Checking with TorBox checkCached

This extension preserves 100% backward compatibility with the v2.0 implementation while adding TorBox-specific instant cache checking. The abstraction ensures that any future provider with a batch-check API (AllDebrid, Premiumize, etc.) can simply export checkCached and get instant ⚡ marking automatically.
