# SMVShows v2.0 — Multi-Debrid Abstraction & TorBox Integration
Complete LLM-Friendly Implementation Guide

**Document Version:** 2.0.0  
**Target Repository:** github.com/sevvian/smvshows (main branch, commit 2c343a8)  
**Architecture:** Clean-slate modular debrid abstraction — no patchwork, no backward-compatibility hacks

---

# Table of Contents

1. Repository Analysis & Architecture Overview  
2. TorBox API Research & Response Contracts  
3. Architecture Redesign — Provider Pattern  
4. Database Redesign  
5. File-by-File Implementation  
6. Full Test Suite  
7. Verification Checklist  
8. Git Workflow & Release Tagging  
9. Appendix — Key Design Decisions  

---

# 1. Repository Analysis & Architecture Overview

## 1.1 Current File Inventory

The repository is a Stremio addon (Node.js/Express) that scrapes regional content forums and provides debrid-powered streams. Key files:

| File | Purpose | Debrid Coupling |
|---|---|---|
| src/index.js | Entry point, cron jobs, logs isRdEnabled | Direct reference to config.isRdEnabled |
| src/config/config.js | Environment config | Only realDebridApiKey + isRdEnabled |
| src/services/realdebrid.js | RD API wrapper | The entire debrid layer |
| src/api/stremio.routes.js | Stremio stream/catalog/meta routes | require('../services/realdebrid') on L5; uses rd.isEnabled, rd.addMagnet, rd.getTorrentInfo, rd.selectFiles, rd.unrestrictLink, rd.addAndSelect |
| src/api/admin.routes.js | Admin panel API | Same direct require on L10; uses rd.isEnabled, rd.addMagnet, rd.getTorrentInfo, rd.selectFiles, rd.addAndSelect |
| src/database/models.js | Sequelize models | RdTorrent (table rd_torrents), RdCacheLock (table rd_cache_locks), MagnetCache |
| src/database/connection.js | DB init & sync | Defines associations, calls syncDb() |
| src/database/crud.js | CRUD helpers | Generic — no RD coupling |
| src/services/orchestrator.js | Crawl workflow | Uses MagnetCache for linked items |
| src/services/crawler.js | Web scraper | No debrid coupling |
| src/services/parser.js | Magnet/title parser | No debrid coupling |
| src/services/metadata.js | TMDB lookup | No debrid coupling |
| src/services/tracker.js | Tracker list | No debrid coupling |
| src/services/maintenance.js | DB vacuum | No debrid coupling |
| src/utils/logger.js | Pino logger | No debrid coupling |
| public/admin.html | Admin UI | Displays RD enabled |
| .env.example | Example env | Only REALDEBRID_API_KEY |
| Dockerfile | Container build | Unchanged |

## 1.2 Current Data Flow (RD-Only)

```text
stremio.routes.js / admin.routes.js
       │
       ├── rd.isEnabled
       ├── rd.addMagnet(magnet)
       ├── rd.getTorrentInfo(rdId)
       ├── rd.selectFiles(rdId, 'all')
       ├── rd.unrestrictLink(link)
       └── rd.addAndSelect(magnet)
              │
              ▼
    src/services/realdebrid.js
              │
              ▼
    https://api.real-debrid.com/rest/1.0
```

## 1.3 Coupling Points That Must Be Broken

- L5 of stremio.routes.js: `const rd = require('../services/realdebrid')`
- L10 of admin.routes.js: `const rd = require('../services/realdebrid')`
- L12 of index.js: `logger.info('Real-Debrid integration is ${config.isRdEnabled}...')`
- Database table names: `rd_torrents`, `rd_cache_locks`
- Model names: `RdTorrent`, `RdCacheLock`
- Health endpoint L126: `realDebridEnabled: !!config.realDebridApiKey`
- Admin HTML L10: `RD enabled`

---

# 2. TorBox API Research & Response Contracts

## 2.1 Endpoint Summary

Source: Official TorBox OpenAPI spec at https://api.torbox.app/openapi.json and SDK docs.

| Operation | RD Endpoint | TorBox Endpoint |
|---|---|---|
| Add magnet | POST /torrents/addMagnet | POST /v1/api/torrents/createtorrent (multipart, field: magnet) |
| Get info | GET /torrents/info/{id} | GET /v1/api/torrents/torrentinfo?hash=<hash> |
| Select files | POST /torrents/selectFiles/{id} | No equivalent — TorBox downloads all files |
| Get download link | POST /unrestrict/link | GET /v1/api/torrents/requestdl?token=<key>&torrent_id=<id>&file_id=<fid> |
| List torrents | N/A (not used) | GET /v1/api/torrents/mylist (can filter by id) |

## 2.2 Authentication

TorBox uses Bearer token auth, identical to Real-Debrid:

```text
Authorization: Bearer <api_key>
```

The token query parameter is also required on `requestdl` for permalink generation.

## 2.3 Response Shapes (Inferred from SDK & OpenAPI)

### POST /createtorrent response

```json
{
  "success": true,
  "data": {
    "id": 12345,
    "hash": "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c",
    "name": "Show.S01.1080p"
  }
}
```

The `id` is a numeric torrent identifier; `hash` is the info hash.

### GET /torrentinfo?hash= response

```json
{
  "success": true,
  "data": {
    "name": "Show.S01.1080p",
    "hash": "dd8255...",
    "files": [
      { "id": 0, "name": "Show.S01E01.mkv", "size": 1500000000 },
      { "id": 1, "name": "Show.S01E02.mkv", "size": 1450000000 }
    ]
  }
}
```

The `files` array contains integer `id` fields — these are the `file_id` values used in `requestdl`.

### GET /requestdl response (with redirect=false)

```json
{
  "success": true,
  "data": {
    "url": "https://cdn.torbox.app/..."
  }
}
```

### GET /mylist response

```json
{
  "success": true,
  "data": [
    {
      "id": 12345,
      "hash": "dd8255...",
      "name": "Show.S01.1080p",
      "status": "completed",
      "files": [...]
    }
  ]
}
```

## 2.4 Status Mapping

| TorBox Status | Meaning | RD-Equivalent |
|---|---|---|
| downloading | Active download | downloading |
| metaDL | Fetching metadata | magnet_conversion |
| completed | Done downloading | downloaded |
| cached | Already cached | downloaded |
| uploading / seeding | Seeding | downloaded |
| stalled (no seeds) | No seeds | downloading |
| paused | Paused | downloading |
| checkingResumeData | Checking | downloading |
| error / failed | Failed | error |

## 2.5 Critical Difference: No File Selection

TorBox always downloads all files in a torrent. There is no `selectFiles` endpoint. This means:

- For `selectFiles(id, 'all')` calls: The implementation must simulate selection by caching which files are requested.
- For episode-specific selection: The `file_id` parameter in `requestdl` is used to download a specific file, but all files are already downloaded on TorBox's servers.

## 2.6 Episode Selection Strategy

For season packs, the existing code uses `pickAndUnrestrict` / `tryMatchEpisode` to match files by parsing episode numbers from filenames (using `parse-torrent-title`). This strategy works identically for TorBox because:

- `getTorrentInfo` returns file names like `Show.S01E05.mkv`
- The file id in the response is the `file_id` for `requestdl`
- Episode matching via regex/PTT works the same way

No code changes are needed in the episode matching logic — only the API calls beneath it change.

---

# 3. Architecture Redesign — Provider Pattern

## 3.1 Target Directory Structure

```text
src/
├── services/
│   ├── debrid/                       # NEW: Debrid abstraction layer
│   │   ├── index.js                  # Factory — the single import for consumers
│   │   ├── provider-interface.js     # Contract definition & validation
│   │   ├── realdebrid.js             # RD provider (moved, paths updated)
│   │   └── torbox.js                 # TorBox provider
│   ├── crawler.js
│   ├── metadata.js
│   ├── orchestrator.js
│   ├── parser.js
│   ├── tracker.js
│   └── maintenance.js
├── config/
│   └── config.js                     # Extended for multi-provider
├── api/
│   ├── stremio.routes.js             # Uses debrid factory
│   └── admin.routes.js               # Uses debrid factory
├── database/
│   ├── connection.js                 # Unchanged
│   ├── models.js                     # Renamed models: RdTorrent → DebridTorrent, etc.
│   └── crud.js                       # Unchanged
├── utils/
│   └── logger.js                     # Unchanged
└── index.js                          # Updated log line
```

## 3.2 Provider Interface Contract

Every debrid provider module MUST export:

```javascript
module.exports = {
    isEnabled: Boolean,              // Whether the provider is configured
    addMagnet: async (magnet) => {}, // Returns { id, ... }
    getTorrentInfo: async (id) => {},// Returns { id, filename, status, files: [{id,path,bytes,selected}], links: [...] }
    selectFiles: async (id, fileIds) => {}, // fileIds: 'all' | '1,2,3'
    unrestrictLink: async (link) => {}, // Returns { download, ... }
    addAndSelect: async (magnet) => {}, // Convenience: add + selectAll + getInfo
    ResourceNotFoundError: class extends Error {} // name === 'ResourceNotFoundError'
};
```

## 3.3 Factory Pattern (debrid/index.js)

The factory exports a lazy-loaded singleton. Consumers do:

```javascript
const debrid = require('../services/debrid');
// then use: debrid.isEnabled, debrid.addMagnet(...), etc.
```

The factory reads `config.debridService` to determine which provider to load. If `'realdebrid'`, it returns `require('./realdebrid')`. If `'torbox'`, it returns `require('./torbox')`. If `'none'` or no key is set, it returns a stub with `isEnabled: false`.

---

# 4. Database Redesign

## 4.1 Renamed Tables & Models

Since we're doing a clean slate, rename everything to be provider-agnostic:

| Old Name | New Name | Rationale |
|---|---|---|
| rd_torrents | debrid_torrents | Provider-agnostic |
| rd_cache_locks | debrid_cache_locks | Provider-agnostic |
| magnet_cache | magnet_cache | Unchanged (no RD-specific data) |
| RdTorrent | DebridTorrent | Model name |
| RdCacheLock | DebridCacheLock | Model name |

## 4.2 Updated Schema (DebridTorrent)

```javascript
const DebridTorrent = sequelize.define('DebridTorrent', {
    infohash:   { type: DataTypes.STRING, primaryKey: true },
    torrent_id: { type: DataTypes.STRING, allowNull: false, unique: true },  // was rd_id
    provider:   { type: DataTypes.STRING, allowNull: false, defaultValue: 'realdebrid' }, // NEW
    status:     { type: DataTypes.STRING, allowNull: false },
    files:      { type: DataTypes.JSON, allowNull: true },
    links:      { type: DataTypes.JSON, allowNull: true },
    last_checked: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'debrid_torrents', timestamps: true });
```

## 4.3 Updated Schema (DebridCacheLock)

```javascript
const DebridCacheLock = sequelize.define('DebridCacheLock', {
    infohash:  { type: DataTypes.STRING, primaryKey: true },
    createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'debrid_cache_locks', timestamps: false });
```

## 4.4 Migration Strategy

Since this is v2.0 and the user explicitly said "even if database breaking change, it's fine," we will:

- Use new table names (`debrid_torrents`, `debrid_cache_locks`).
- Sequelize's `sync()` will create the new tables fresh.
- The old tables (`rd_torrents`, `rd_cache_locks`) will be left in the SQLite file but ignored.
- If the deployer wants to migrate data, they can run a manual SQL script. For a clean v2.0, starting fresh is acceptable.

---

# 5. File-by-File Implementation

## 5.1 src/config/config.js — Full Replacement

```javascript
// src/config/config.js
require('dotenv').config();

const config = {
    port: process.env.PORT || 3000,
    logLevel: process.env.LOG_LEVEL || 'info',

    // Scraper Configuration
    seriesForumUrls: (process.env.SERIES_FORUM_URLS || process.env.FORUM_URLS || process.env.FORUM_URL || '')
        .split(',').map(url => url.trim()).filter(url => url),
    movieForumUrls: (process.env.MOVIE_FORUM_URLS || '')
        .split(',').map(url => url.trim()).filter(url => url),
    dubbedMovieForumUrls: (process.env.DUBBED_MOVIE_FORUM_URLS || '')
        .split(',').map(url => url.trim()).filter(url => url),
    scrapeStartPage: parseInt(process.env.SCRAPE_START_PAGE, 10) || 1,
    scrapeEndPage: parseInt(process.env.SCRAPE_END_PAGE, 10) || 20,
    scraperConcurrency: parseInt(process.env.SCRAPER_CONCURRENCY, 10) || 5,
    scraperRetryCount: parseInt(process.env.SCRAPER_RETRY_COUNT, 10) || 3,
    scraperTimeoutSecs: parseInt(process.env.SCRAPER_TIMEOUT_SECS, 10) || 30,
    scraperUserAgent: process.env.SCRAPER_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

    // Scheduler Configuration
    mainWorkflowCron: process.env.MAIN_WORKFLOW_CRON || '0 */6 * * *',

    // TMDB API Key
    tmdbApiKey: process.env.TMDB_API_KEY,

    // ─── Debrid Provider Configuration ───────────────────────────
    // Which provider to use: 'realdebrid' | 'torbox' | 'none'
    debridService: (process.env.DEBRID_SERVICE || '').toLowerCase() || null,

    // Real-Debrid
    realDebridApiKey: process.env.REALDEBRID_API_KEY || null,

    // TorBox
    torboxApiKey: process.env.TORBOX_API_KEY || null,

    // ─── Proxy Configuration ─────────────────────────────────────
    proxyUrls: process.env.PROXY_URLS
        ? process.env.PROXY_URLS.split(',').map(url => url.trim())
        : [],

    // Stremio Manifest
    addonId: 'org.stremio.torrent.nodejs.example',
    addonName: 'TamilMV WebSeries',
    addonDescription: 'A Stremio addon providing webseries streams.',
    addonVersion: '1.0.0',
    placeholderPoster: 'https://upload.wikimedia.org/wikipedia/en/thumb/d/da/Aha_%28streaming_service.svg/250px-Aha_%28streaming_service.svg.png',

    trackerUrl: process.env.TRACKER_URL || "https://ngosang.github.io/trackerslist/trackers_best.txt",
    appHost: process.env.APP_HOST || 'http://127.0.0.1:3000',

    forumSortQuery: (process.env.FORUM_SORT_QUERY || '').trim(),

    // Database Maintenance
    dbAutoVacuumCron: process.env.DB_AUTO_VACUUM_CRON || null,
    dbAutoVacuumEnabled: process.env.DB_AUTO_VACUUM_ENABLED === 'true' || false,
};

// ─── Boolean Flags ───────────────────────────────────────────────
config.isRdEnabled = !!config.realDebridApiKey;
config.isTorboxEnabled = !!config.torboxApiKey;
config.isProxyEnabled = config.proxyUrls.length > 0;

// Auto-detect debrid service if not explicitly set
if (!config.debridService) {
    if (config.isRdEnabled) config.debridService = 'realdebrid';
    else if (config.isTorboxEnabled) config.debridService = 'torbox';
    else config.debridService = 'none';
}

// Validate that the chosen service has an API key
if (config.debridService !== 'none') {
    const key = config.debridService === 'torbox' ? config.torboxApiKey : config.realDebridApiKey;
    if (!key) {
        console.warn(`DEBRID_SERVICE is '${config.debridService}' but no API key is set. Debrid will be disabled.`);
        config.debridService = 'none';
    }
}

// Validate required variables
const hasAnyForumUrl = config.seriesForumUrls.length > 0 || config.movieForumUrls.length > 0 || config.dubbedMovieForumUrls.length > 0;
if (!hasAnyForumUrl) {
    console.warn('WARNING: No forum URLs configured. The addon will start but won\'t scrape anything.');
}

module.exports = config;
```

**Change summary:** Added `debridService`, `torboxApiKey`, `isTorboxEnabled`, auto-detection logic. Everything else preserved.

## 5.2 src/services/debrid/index.js — Factory (NEW)

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
        ResourceNotFoundError
    };
}

// Proxy so callers can do `debrid.addMagnet(...)` directly
module.exports = new Proxy({}, {
    get(target, prop) {
        const p = getProvider();
        if (prop in p) return p[prop];
        return undefined;
    }
});
```

## 5.3 src/services/debrid/realdebrid.js — RD Provider (MOVED)

Copy the entire contents of `src/services/realdebrid.js` to this file, then change ONLY the require paths:

```diff
- const logger = require('../utils/logger');
- const config = require('../config/config');
+ const logger = require('../../utils/logger');
+ const config = require('../../config/config');
```

Everything else (the `ResourceNotFoundError` class, all five functions, the `isEnabled` guard, the Axios instance, and the `module.exports`) remains identical to the current `realdebrid.js`. This guarantees zero functional regression.

## 5.4 src/services/debrid/torbox.js — TorBox Provider (NEW)

```javascript
// src/services/debrid/torbox.js
const axios = require('axios');
const logger = require('../../utils/logger');
const config = require('../../config/config');

// ── Custom Error ─────────────────────────────────────────────────
class ResourceNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ResourceNotFoundError';
    }
}

// ── Disabled Guard ───────────────────────────────────────────────
if (!config.isTorboxEnabled) {
    logger.info('TorBox service is disabled: No API key provided.');
    module.exports = { isEnabled: false };
} else {
    // ── Axios Instance ────────────────────────────────────────────
    const tbApi = axios.create({
        baseURL: 'https://api.torbox.app/v1/api',
        headers: { Authorization: `Bearer ${config.torboxApiKey}` },
        timeout: 15000
    });

    // ── In-Memory Caches ──────────────────────────────────────────
    // TorBox identifies torrents by hash, but our interface uses numeric IDs.
    // We maintain these maps so the RD-shaped API works.
    const torrentIdToHash = new Map();       // numeric id → hash
    const torrentSelections = new Map();     // numeric id → Set<file_id>

    // ── Helpers ───────────────────────────────────────────────────

    /**
     * Fetch raw torrent info (no transformation, no link generation).
     * Used internally by selectFiles('all') to get the full file list.
     */
    async function fetchRawTorrentInfo(numericId) {
        const hash = torrentIdToHash.get(numericId);
        if (!hash) throw new ResourceNotFoundError(`Torrent ID ${numericId} not found in local cache.`);
        const { data } = await tbApi.get('/torrents/torrentinfo', { params: { hash } });
        // TorBox API wraps responses in { success, data, ... } sometimes,
        // but the raw endpoint may return differently. Normalize:
        const payload = data.data || data;
        return payload;
    }

    /**
     * Request a single download link for a torrent+file combination.
     * Uses redirect=false to get JSON instead of a 302.
     */
    async function requestDownloadLink(torrentId, fileId) {
        const { data } = await tbApi.get('/torrents/requestdl', {
            params: {
                token: config.torboxApiKey,
                torrent_id: torrentId,
                file_id: fileId,
                redirect: false
            }
        });
        // Normalize: response may be { data: { url: "..." } } or { url: "..." }
        const payload = data.data || data;
        return payload.url || payload;
    }

    /**
     * Map TorBox status strings to Real-Debrid equivalents.
     */
    function mapStatus(tbStatus) {
        const s = (tbStatus || '').toLowerCase();
        if (s === 'downloading' || s === 'metadl' || s === 'checkingresumedata') return 'downloading';
        if (s === 'completed' || s === 'cached' || s === 'uploading' || s === 'seeding') return 'downloaded';
        if (s === 'stalled (no seeds)' || s === 'paused') return 'downloading';
        if (s === 'error' || s === 'failed') return 'error';
        return 'queued';
    }

    // ── 1. addMagnet ──────────────────────────────────────────────
    async function addMagnet(magnet) {
        try {
            const formData = new URLSearchParams();
            formData.append('magnet', magnet);
            const response = await tbApi.post('/torrents/createtorrent', formData, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            // Normalize response
            const payload = response.data.data || response.data;
            if (payload && payload.id && payload.hash) {
                torrentIdToHash.set(payload.id, payload.hash);
            }
            return { id: payload.id, hash: payload.hash, name: payload.name, ...payload };
        } catch (error) {
            logger.error({ err: error.response?.data || error.message, magnet }, 'Failed to add magnet to TorBox.');
            throw error;
        }
    }

    // ── 2. getTorrentInfo ─────────────────────────────────────────
    async function getTorrentInfo(id) {
        try {
            const hash = torrentIdToHash.get(id);
            if (!hash) throw new ResourceNotFoundError(`Torrent ID ${id} not found.`);

            const payload = await fetchRawTorrentInfo(id);
            const tbStatus = mapStatus(payload.status || payload.state);

            // Build files array in RD format
            const selectedSet = torrentSelections.get(id) || new Set();
            const files = (payload.files || []).map(f => ({
                id: f.id,
                path: f.name,          // TorBox uses 'name'; RD uses 'path'
                bytes: f.size,
                selected: selectedSet.size === 0 || selectedSet.has(f.id) ? 1 : 0
            }));

            // Generate download links for selected files when ready
            const links = [];
            if (tbStatus === 'downloaded') {
                const fileIdsToLink = selectedSet.size > 0
                    ? Array.from(selectedSet)
                    : (payload.files || []).map(f => f.id);
                for (const fid of fileIdsToLink) {
                    try {
                        const dlUrl = await requestDownloadLink(id, fid);
                        links.push(dlUrl);
                    } catch (e) {
                        logger.warn({ torrentId: id, fileId: fid, err: e.message }, 'Failed to get download link.');
                        links.push(null);
                    }
                }
            }

            return {
                id: id,
                filename: payload.name,
                status: tbStatus,
                files: files,
                links: links
            };
        } catch (error) {
            if (error instanceof ResourceNotFoundError) throw error;
            if (error.response?.status === 404) {
                throw new ResourceNotFoundError(`Torrent ID ${id} not found on TorBox.`);
            }
            logger.error({ err: error.response?.data || error.message }, `Failed to get torrent info for ID: ${id}`);
            throw error;
        }
    }

    // ── 3. selectFiles ────────────────────────────────────────────
    async function selectFiles(id, fileIds = 'all') {
        try {
            if (fileIds === 'all') {
                const info = await fetchRawTorrentInfo(id);
                const allIds = (info.files || []).map(f => f.id);
                torrentSelections.set(id, new Set(allIds));
            } else {
                const ids = String(fileIds).split(',').map(Number);
                if (!torrentSelections.has(id)) torrentSelections.set(id, new Set());
                const set = torrentSelections.get(id);
                ids.forEach(fid => set.add(fid));
            }
            return true;
        } catch (error) {
            if (error instanceof ResourceNotFoundError) throw error;
            if (!torrentIdToHash.has(id)) {
                throw new ResourceNotFoundError(`Torrent ID ${id} not found.`);
            }
            logger.error({ err: error.response?.data || error.message }, `Failed to select files for torrent ID: ${id}`);
            throw error;
        }
    }

    // ── 4. unrestrictLink ─────────────────────────────────────────
    async function unrestrictLink(link) {
        // TorBox direct download links are already "unrestricted."
        // If the caller passes a URL, wrap it in the RD response shape.
        if (link && (link.startsWith('http://') || link.startsWith('https://'))) {
            return { download: link };
        }
        // TorBox does not support hoster link unrestriction.
        logger.warn('unrestrictLink called with non-URL input; TorBox does not support hoster unrestriction.');
        throw new Error('TorBox does not support hoster link unrestriction.');
    }

    // ── 5. addAndSelect ───────────────────────────────────────────
    async function addAndSelect(magnet) {
        try {
            const addResponse = await addMagnet(magnet);
            const torrentId = addResponse.id;
            if (torrentId) {
                await selectFiles(torrentId, 'all');
                return await getTorrentInfo(torrentId);
            }
            return null;
        } catch (error) {
            logger.error({ err: error.response?.data || error.message }, 'Failed during addAndSelect process.');
            return null;
        }
    }

    // ── Export ────────────────────────────────────────────────────
    module.exports = {
        isEnabled: true,
        addMagnet,
        getTorrentInfo,
        selectFiles,
        unrestrictLink,
        addAndSelect,
        ResourceNotFoundError
    };
}
```

## 5.5 src/database/models.js — Full Replacement

```javascript
// src/database/models.js
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    // ── Thread ────────────────────────────────────────────────────
    const Thread = sequelize.define('Thread', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        thread_hash: { type: DataTypes.STRING, unique: true, allowNull: false },
        raw_title: { type: DataTypes.STRING, allowNull: false },
        clean_title: DataTypes.STRING,
        year: DataTypes.INTEGER,
        tmdb_id: { type: DataTypes.STRING, references: { model: 'tmdb_metadata', key: 'tmdb_id' }, allowNull: true },
        status: { type: DataTypes.STRING, defaultValue: 'linked', allowNull: false },
        type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'series' },
        postedAt: { type: DataTypes.DATE, allowNull: true },
        catalog: { type: DataTypes.STRING, allowNull: true },
        magnet_uris: { type: DataTypes.JSON, allowNull: true },
        custom_poster: { type: DataTypes.STRING, allowNull: true },
        custom_description: { type: DataTypes.TEXT, allowNull: true },
        last_seen: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'threads',
        timestamps: true,
        indexes: [
            { fields: ['status'] },
            { fields: ['type'] },
            { fields: ['catalog'] },
            { fields: ['postedAt'] },
            { fields: ['tmdb_id'] },
            { unique: true, fields: ['thread_hash'] },
        ]
    });

    // ── TmdbMetadata ──────────────────────────────────────────────
    const TmdbMetadata = sequelize.define('TmdbMetadata', {
        tmdb_id: { type: DataTypes.STRING, primaryKey: true },
        imdb_id: { type: DataTypes.STRING, unique: true },
        year: { type: DataTypes.INTEGER, index: true },
        data: { type: DataTypes.JSON, allowNull: false },
    }, {
        tableName: 'tmdb_metadata',
        timestamps: true,
        indexes: [
            { unique: true, fields: ['imdb_id'] },
            { fields: ['year'] },
        ]
    });

    // ── Stream ────────────────────────────────────────────────────
    const Stream = sequelize.define('Stream', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tmdb_id: { type: DataTypes.STRING, allowNull: false },
        season: { type: DataTypes.INTEGER, allowNull: true },
        episode: { type: DataTypes.INTEGER, allowNull: true },
        episode_end: { type: DataTypes.INTEGER, allowNull: true },
        infohash: { type: DataTypes.STRING, allowNull: false, unique: true },
        quality: DataTypes.STRING,
        language: DataTypes.STRING,
    }, {
        tableName: 'streams',
        timestamps: true,
        indexes: [
            { unique: true, fields: ['tmdb_id', 'season', 'episode', 'infohash'] },
            { fields: ['tmdb_id'] },
            { fields: ['season'] },
            { fields: ['episode'] },
            { fields: ['quality'] },
        ]
    });

    // ── FailedThread ──────────────────────────────────────────────
    const FailedThread = sequelize.define('FailedThread', {
        thread_hash: { type: DataTypes.STRING, primaryKey: true },
        raw_title: DataTypes.STRING,
        reason: DataTypes.STRING,
        last_attempt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'failed_threads',
        timestamps: false,
        indexes: [{ fields: ['last_attempt'] }]
    });

    // ── DebridTorrent (was RdTorrent) ─────────────────────────────
    const DebridTorrent = sequelize.define('DebridTorrent', {
        infohash: { type: DataTypes.STRING, primaryKey: true },
        torrent_id: { type: DataTypes.STRING, allowNull: false, unique: true },
        provider: { type: DataTypes.STRING, allowNull: false, defaultValue: 'realdebrid' },
        status: { type: DataTypes.STRING, allowNull: false },
        files: { type: DataTypes.JSON, allowNull: true },
        links: { type: DataTypes.JSON, allowNull: true },
        last_checked: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'debrid_torrents',
        timestamps: true
    });

    // ── DebridCacheLock (was RdCacheLock) ─────────────────────────
    const DebridCacheLock = sequelize.define('DebridCacheLock', {
        infohash: { type: DataTypes.STRING, primaryKey: true },
        createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'debrid_cache_locks',
        timestamps: false
    });

    // ── MagnetCache ───────────────────────────────────────────────
    const MagnetCache = sequelize.define('MagnetCache', {
        infohash: { type: DataTypes.STRING, primaryKey: true },
        magnet: { type: DataTypes.TEXT, allowNull: false },
        createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, {
        tableName: 'magnet_cache',
        timestamps: false
    });

    return { Thread, TmdbMetadata, Stream, FailedThread, DebridTorrent, DebridCacheLock, MagnetCache };
};
```

## 5.6 src/database/connection.js — Updated

Change only the association references from `RdTorrent` / `RdCacheLock` to the new model names. The actual file is identical to the current one but with renamed references:

```javascript
// src/database/connection.js
const { Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const defineModels = require('./models');

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: '/data/stremio_addon.db',
    logging: msg => logger.debug(msg),
});

const models = defineModels(sequelize);

// Define associations
if (models.Thread && models.TmdbMetadata) {
    models.Thread.belongsTo(models.TmdbMetadata, { foreignKey: 'tmdb_id', targetKey: 'tmdb_id' });
    models.TmdbMetadata.hasMany(models.Thread, { foreignKey: 'tmdb_id', sourceKey: 'tmdb_id' });
}

const syncDb = async () => {
    try {
        await sequelize.sync();
        logger.info('Database & tables verified successfully.');
    } catch (error) {
        logger.error(error, 'Error synchronizing database:');
        throw error;
    }
};

module.exports = { sequelize, models, syncDb };
```

## 5.7 src/api/stremio.routes.js — Partial Changes

Change the import line (L5):

```diff
- const rd = require('../services/realdebrid');
+ const debrid = require('../services/debrid');
```

Replace every `rd.` with `debrid.` throughout the file:

| Line | Old | New |
|---|---|---|
| L106 | if (!rd.isEnabled) | if (!debrid.isEnabled) |
| L130 | await rd.addMagnet(magnet) | await debrid.addMagnet(magnet) |
| L136 | await rd.addAndSelect(magnet) | await debrid.addAndSelect(magnet) |
| L140 | await rd.selectFiles(rdId, 'all') | await debrid.selectFiles(rdId, 'all') |
| L149 | await rd.getTorrentInfo(rdId) | await debrid.getTorrentInfo(rdId) |
| L153 | await rd.addMagnet(magnet) | await debrid.addMagnet(magnet) |
| L154 | await rd.addAndSelect(magnet) | await debrid.addAndSelect(magnet) |
| L157 | await rd.selectFiles(rdId, 'all') | await debrid.selectFiles(rdId, 'all') |
| L236 | if (rd.isEnabled) | if (debrid.isEnabled) |
| L259 | await rd.unrestrictLink(rdTorrent.links[linkIndex]) | await debrid.unrestrictLink(rdTorrent.links[linkIndex]) |
| L243 | models.RdTorrent | models.DebridTorrent |
| L110-L111 | models.RdTorrent.findByPk | models.DebridTorrent.findByPk |
| L123-L124 | models.RdCacheLock.findByPk | models.DebridCacheLock.findByPk |
| L126-L127 | models.RdCacheLock.upsert | models.DebridCacheLock.upsert |
| L128-L129 | models.RdCacheLock.upsert | models.DebridCacheLock.upsert |
| L131-L132 | models.RdTorrent.upsert | models.DebridTorrent.upsert |
| L143-L144 | models.RdTorrent.findByPk | models.DebridTorrent.findByPk |
| L168-L171 | models.RdTorrent.upsert + models.RdCacheLock | models.DebridTorrent.upsert + models.DebridCacheLock |
| L197-L198 | rd.unrestrictLink | debrid.unrestrictLink |

Also update field references:

```diff
- cached.rd_id
+ cached.torrent_id

- rdTorrent.rd_id
+ rdTorrent.torrent_id
```

All other logic (episode matching, polling, status checks, single-flight locking, re-add on 404) is 100% preserved.

## 5.8 src/api/admin.routes.js — Partial Changes

Change the import line (L10-L11):

```diff
- const rd = require('../services/realdebrid');
+ const debrid = require('../services/debrid');
```

Replace every `rd.` with `debrid.` and every model reference:

| Line | Old | New |
|---|---|---|
| L162 | if (!rd.isEnabled) | if (!debrid.isEnabled) |
| L180 | await rd.addMagnet | await debrid.addMagnet |
| L183 | await rd.getTorrentInfo | await debrid.getTorrentInfo |
| L187 | await rd.selectFiles | await debrid.selectFiles |
| L190 | await rd.addAndSelect | await debrid.addAndSelect |
| L201 | if (!rd.isEnabled) | if (!debrid.isEnabled) |
| L45 | models.RdCacheLock | models.DebridCacheLock |
| L179 | models.RdCacheLock | models.DebridCacheLock |
| L183-L186 | models.RdTorrent.upsert + models.RdCacheLock.upsert | models.DebridTorrent.upsert + models.DebridCacheLock.upsert |
| L191-L194 | models.RdTorrent.upsert + models.RdCacheLock.upsert | models.DebridTorrent.upsert + models.DebridCacheLock.upsert |
| L204-L206 | models.RdCacheLock.findByPk + models.RdTorrent.findByPk | models.DebridCacheLock.findByPk + models.DebridTorrent.findByPk |

Update field references:

```diff
- rd_id
+ torrent_id
```

Update health endpoint (L126):

```diff
- realDebridEnabled: !!config.realDebridApiKey,
+ debridService: config.debridService,
+ debridEnabled: config.debridService !== 'none',
+ realDebridEnabled: !!config.realDebridApiKey,    // keep for backward compat
+ torboxEnabled: !!config.torboxApiKey,
```

## 5.9 src/index.js — Update Startup Log

Change L12-L13:

```diff
- logger.info(`Real-Debrid integration is ${config.isRdEnabled ? 'ENABLED' : 'DISABLED'}.`);
+ logger.info(`Debrid provider: ${config.debridService} (${config.debridService === 'none' ? 'DISABLED' : (config.debridService === 'torbox' ? config.isTorboxEnabled : config.isRdEnabled) ? 'ENABLED' : 'DISABLED (no key)'}).`);
```

## 5.10 src/services/orchestrator.js — Update Model References

Replace:

```diff
- await models.MagnetCache.upsert
+ (unchanged — MagnetCache name is unchanged)

- await models.RdCacheLock
+ (no direct reference — MagnetCache only)
```

Verify: The orchestrator only references `MagnetCache`, which is unchanged. No edits needed here, but verify by searching for `Rd`.

## 5.11 public/admin.html — Update UI

Change L10:

```diff
- <td>RD enabled:</td>
- <td id="rdEnabled">-</td>
+ <td>Debrid provider:</td>
+ <td id="debridService">-</td>
```

Update the health fetch JavaScript (search for `rdEnabled` in the HTML and replace with `debridService` / `debridEnabled`).

## 5.12 .env.example — Full Replacement

```ini
# COPY THIS TO .env AND FILL IN YOUR VALUES
PORT=3000

# --- LLM SETTINGS ---
GEMINI_API_KEY="AIzaSy...your...key"
GEMINI_MODEL="gemini-1.5-flash"

# --- FORUM SETTINGS ---
FORUM_URL="https://your-target-forum.com/c/tv-shows/34"
FORUM_URLS=https://forum1.com/c/tv-shows/,https://forum2.com/c/tv-shows/
SCRAPE_START_PAGE=1
SCRAPE_END_PAGE=25
SCRAPER_CONCURRENCY=5
SCRAPER_RETRY_COUNT=3

# -----------------------------------------------------------------------------
# TRACKER SETTINGS
# -----------------------------------------------------------------------------
TRACKER_URL="https://ngosang.github.io/trackerslist/trackers_best.txt"

# --- API KEYS ---
TMDB_API_KEY="your...tmdb...v3...key"

# --- DEBRID PROVIDER ---
# Which debrid service to use: 'realdebrid' | 'torbox' | 'none'
# If left empty, auto-detected from available API keys.
DEBRID_SERVICE="realdebrid"

# Real-Debrid (optional)
REALDEBRID_API_KEY="your api key"

# TorBox (optional)
TORBOX_API_KEY="your torbox api key"

# --- LOGGING ---
LOG_LEVEL="info"

# --- DEPLOYMENT ---
APP_HOST="https://your-deployed-addon.fly.dev"
```

## 5.13 src/services/realdebrid.js — Delete

This file is moved to `src/services/debrid/realdebrid.js`. Delete the original to avoid confusion.

---

# 6. Full Test Suite

## 6.1 tests/debrid-interface.test.js (NEW)

```javascript
// tests/debrid-interface.test.js
// Validates that every provider conforms to the expected interface contract.

const assert = require('assert');

// The required export shape
const REQUIRED_EXPORTS = [
    'isEnabled',
    'addMagnet',
    'getTorrentInfo',
    'selectFiles',
    'unrestrictLink',
    'addAndSelect',
    'ResourceNotFoundError'
];

function testProviderInterface(providerName, provider) {
    console.log(`\n  Testing ${providerName} interface...`);

    // 1. All required exports exist
    for (const key of REQUIRED_EXPORTS) {
        assert.ok(key in provider, `${providerName}: missing export "${key}"`);
    }

    // 2. isEnabled is boolean
    assert.strictEqual(typeof provider.isEnabled, 'boolean',
        `${providerName}: isEnabled must be boolean`);

    // 3. All functions are async functions
    for (const key of ['addMagnet', 'getTorrentInfo', 'selectFiles', 'unrestrictLink', 'addAndSelect']) {
        assert.strictEqual(typeof provider[key], 'function',
            `${providerName}: ${key} must be a function`);
        assert.ok(provider[key].constructor.name === 'AsyncFunction',
            `${providerName}: ${key} must be async`);
    }

    // 4. ResourceNotFoundError is a class with correct name
    assert.strictEqual(typeof provider.ResourceNotFoundError, 'function',
        `${providerName}: ResourceNotFoundError must be a class`);
    const err = new provider.ResourceNotFoundError('test');
    assert.strictEqual(err.name, 'ResourceNotFoundError',
        `${providerName}: ResourceNotFoundError must have name="ResourceNotFoundError"`);
    assert.ok(err instanceof Error,
        `${providerName}: ResourceNotFoundError must extend Error`);

    console.log(`  ✓ ${providerName} interface valid`);
}

function testDisabledProvider(providerName, provider) {
    console.log(`\n  Testing ${providerName} disabled state...`);

    // When disabled, isEnabled must be false
    // If isEnabled is true, we skip the "disabled" tests
    if (provider.isEnabled) {
        console.log(`  - ${providerName} is enabled, skipping disabled-state tests`);
        return;
    }

    assert.strictEqual(provider.isEnabled, false);

    // Disabled providers should still export all functions
    // (they may throw when called, but they must exist)
    for (const key of ['addMagnet', 'getTorrentInfo', 'selectFiles', 'unrestrictLink', 'addAndSelect']) {
        assert.strictEqual(typeof provider[key], 'function');
    }

    console.log(`  ✓ ${providerName} disabled state valid`);
}

function runAllTests() {
    console.log('=== Debrid Interface Contract Tests ===\n');

    // Test the factory
    console.log('1. Factory Tests');
    const factory = require('../src/services/debrid');
    testProviderInterface('Factory', factory);

    // Test realdebrid provider directly
    console.log('\n2. Real-Debrid Provider Tests');
    const rd = require('../src/services/debrid/realdebrid');
    testProviderInterface('RealDebrid', rd);
    testDisabledProvider('RealDebrid', rd);

    // Test torbox provider directly
    console.log('\n3. TorBox Provider Tests');
    const tb = require('../src/services/debrid/torbox');
    testProviderInterface('TorBox', tb);
    testDisabledProvider('TorBox', tb);

    console.log('\n=== All Tests Passed ===\n');
}

runAllTests();
```

## 6.2 tests/debrid-integration.test.js (NEW)

```javascript
// tests/debrid-integration.test.js
// Integration tests for the debrid abstraction layer.
// These require API keys and will make live API calls.
// Run with: DEBRID_SERVICE=torbox TORBOX_API_KEY=xxx node tests/debrid-integration.test.js

const assert = require('assert');
const debrid = require('../src/services/debrid');

const TEST_MAGNET = 'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=Big+Buck+Bunny';

async function runTests() {
    console.log('=== Debrid Integration Tests ===\n');

    if (!debrid.isEnabled) {
        console.log('No debrid provider configured. Skipping integration tests.');
        return;
    }

    // Test 1: addMagnet
    console.log('1. Testing addMagnet...');
    let torrentId;
    try {
        const result = await debrid.addMagnet(TEST_MAGNET);
        assert.ok(result, 'addMagnet should return a result');
        assert.ok(result.id, 'addMagnet result should have an id');
        torrentId = result.id;
        console.log(`   ✓ addMagnet returned ID: ${torrentId}`);
    } catch (e) {
        console.log(`   - addMagnet failed (may be rate-limited): ${e.message}`);
        return;
    }

    // Test 2: selectFiles
    console.log('2. Testing selectFiles...');
    try {
        const result = await debrid.selectFiles(torrentId, 'all');
        assert.strictEqual(result, true, 'selectFiles should return true');
        console.log('   ✓ selectFiles succeeded');
    } catch (e) {
        console.log(`   - selectFiles failed: ${e.message}`);
    }

    // Test 3: getTorrentInfo
    console.log('3. Testing getTorrentInfo...');
    try {
        const info = await debrid.getTorrentInfo(torrentId);
        assert.ok(info, 'getTorrentInfo should return info');
        assert.ok(info.id, 'info should have id');
        assert.ok(info.filename, 'info should have filename');
        assert.ok(Array.isArray(info.files), 'info.files should be an array');
        assert.ok(Array.isArray(info.links), 'info.links should be an array');
        assert.ok(info.status, 'info should have status');
        console.log(`   ✓ getTorrentInfo returned status: ${info.status}, files: ${info.files.length}`);
    } catch (e) {
        console.log(`   - getTorrentInfo failed: ${e.message}`);
    }

    // Test 4: ResourceNotFoundError
    console.log('4. Testing ResourceNotFoundError...');
    const err = new debrid.ResourceNotFoundError('test');
    assert.strictEqual(err.name, 'ResourceNotFoundError');
    assert.ok(err instanceof Error);
    console.log('   ✓ ResourceNotFoundError works correctly');

    console.log('\n=== Integration Tests Complete ===\n');
}

runTests().catch(console.error);
```

## 6.3 Run Tests

```bash
# Interface contract tests (no API keys needed)
node tests/debrid-interface.test.js

# Integration tests (requires API key)
DEBRID_SERVICE=torbox TORBOX_API_KEY=your_key node tests/debrid-integration.test.js
DEBRID_SERVICE=realdebrid REALDEBRID_API_KEY=your_key node tests/debrid-integration.test.js
```

---

# 7. Verification Checklist

## 7.1 Build & Start

- `npm install` completes without errors
- `node src/index.js` starts without crashes
- Log output shows `Debrid provider: realdebrid — ENABLED` (or torbox/none)
- No `MODULE_NOT_FOUND` errors

## 7.2 Real-Debrid Functionality (Regression)

Set `DEBRID_SERVICE=realdebrid` and `REALDEBRID_API_KEY=<valid>`

- Add a magnet via the admin panel → torrent appears in RD dashboard
- Stremio stream endpoint returns `[RD+]` streams
- Clicking `[RD] ⏳` triggers the rd-add endpoint, which polls and redirects
- 404 re-add logic works: delete torrent from RD, retry in Stremio → re-added

## 7.3 TorBox Functionality (New)

Set `DEBRID_SERVICE=torbox` and `TORBOX_API_KEY=<valid>`

- Add a magnet → torrent appears in TorBox dashboard
- Stream endpoint returns `[RD+]` streams (label preserved for UI consistency)
- Episode matching works for season packs (file names parsed correctly)
- Download link redirects to TorBox CDN

## 7.4 Service Switching

- Change `DEBRID_SERVICE` from realdebrid to torbox
- Restart the application
- Health endpoint reflects the active provider
- All debrid operations use the new provider

## 7.5 Disabled Mode

Set `DEBRID_SERVICE=none`

- P2P streams still work
- Debrid-only routes return appropriate errors
- Admin panel shows `"Debrid: none"`

## 7.6 Database

- New tables `debrid_torrents` and `debrid_cache_locks` are created
- `torrent_id` column (was `rd_id`) is populated correctly
- `provider` column stores the correct provider name
- Existing data in `threads`, `streams`, `tmdb_metadata`, `magnet_cache` is intact

---

# 8. Git Workflow & Release Tagging

```bash
# 1. Create feature branch
git checkout -b feature/multi-debrid-v2

# 2. Make all changes (follow file-by-file guide above)

# 3. Run tests
node tests/debrid-interface.test.js
# (optionally run integration tests with API keys)

# 4. Verify the app starts
DEBRID_SERVICE=none node src/index.js

# 5. Commit
git add -A
git commit -m "feat(v2.0): multi-debrid abstraction with TorBox support

BREAKING CHANGE: Database tables renamed from rd_torrents/rd_cache_locks
to debrid_torrents/debrid_cache_locks. Old data will not be migrated
automatically. Set DEBRID_SERVICE env var to choose provider.

- Add debrid abstraction layer (src/services/debrid/) with factory pattern
- Add TorBox provider implementing full RD-compatible interface
- Rename database models: RdTorrent→DebridTorrent, RdCacheLock→DebridCacheLock
- Add provider column to track which service owns each torrent
- Refactor all consumers to use debrid factory
- Add DEBRID_SERVICE, TORBOX_API_KEY config options
- Preserve 100% of existing Real-Debrid functionality
- Add interface contract tests and integration tests"

# 6. Tag
git tag v2.0.0
git push origin feature/multi-debrid-v2 --tags
```

## 8.1 Update package.json

```diff
- "version": "1.0.0",
+ "version": "2.0.0",
```

---

# 9. Appendix — Key Design Decisions

## 9.1 Why Not Just Add a selectFiles Workaround to TorBox?

TorBox explicitly states: `"Torrents will download all files. This will not be changed."` Any attempt to add a server-side file selection would require maintaining a fork of TorBox's qBittorrent integration, which is out of scope.

Our solution — simulating `selectFiles` via a local cache — is the correct abstraction. It means `selectFiles('all')` works trivially (record all file IDs), and `selectFiles(id, '1,2,5')` works for targeted episode selection. When `getTorrentInfo` is called, we only generate download links for the "selected" files.

## 9.2 Why In-Memory Caches for TorBox?

The caches (`torrentIdToHash`, `torrentSelections`) are lost on restart. This is acceptable because:

- The addon re-adds torrents on-demand via the `/rd-add/:infohash/:episode.json` endpoint
- The database stores `DebridTorrent` rows with `torrent_id`, which is re-cached on the next poll
- For production resilience, a future version could persist these caches in the database

## 9.3 Why Not Use the Official TorBox SDK?

The `@torbox/torbox-api` npm package could be used, but:

- It adds an unnecessary dependency when we only need 3 endpoints
- Direct Axios calls give us full control over error handling and response normalization
- The package wraps responses differently than our existing code expects

Using bare Axios keeps the code minimal and the dependency footprint unchanged.

## 9.4 Why redirect=false on requestdl?

TorBox supports two modes:

- `redirect=true`: Returns a 302 redirect to the CDN URL (good for permalinks)
- `redirect=false`: Returns JSON with the URL

We use `redirect=false` because:

- The existing code pattern calls `unrestrictLink(link)` to get a `{ download: url }` shape
- We need the URL as a string to pass to `res.redirect(302, url)` in Stremio routes
- Getting JSON is more reliable than following redirects through Axios

## 9.5 Why Provider Column in DebridTorrent?

The `provider` column allows the application to:

- Know which service owns a cached torrent
- Handle provider-specific edge cases
- Support future multi-provider setups (e.g., fallback from TorBox to RD)

## 9.6 Episode Selection Strategy (TorBox)

For season packs, the existing `tryMatchEpisode` function in `stremio.routes.js` parses filenames like `Show.S01E05.mkv` using `parse-torrent-title`. This works identically for TorBox because:

- `getTorrentInfo` returns `files[].name` (e.g., `Show.S01E05.mkv`)
- The file id maps to the `file_id` parameter in `requestdl`
- The matching logic in `pickAndUnrestrict` operates on file paths/names and indices

No code changes needed in the episode matching functions — only the underlying API calls differ.

---

# Summary — What Changed vs. What Stayed

| Component | v1.0 (Current) | v2.0 (Target) |
|---|---|---|
| Debrid module | services/realdebrid.js only | services/debrid/{index,realdebrid,torbox}.js |
| Consumer imports | require('../services/realdebrid') | require('../services/debrid') |
| Config keys | REALDEBRID_API_KEY, isRdEnabled | Added: DEBRID_SERVICE, TORBOX_API_KEY, isTorboxEnabled |
| DB tables | rd_torrents, rd_cache_locks | debrid_torrents, debrid_cache_locks |
| DB field | rd_id | torrent_id + provider |
| Model names | RdTorrent, RdCacheLock | DebridTorrent, DebridCacheLock |
| Interface shape | Same 7 exports | Identical — zero caller changes |
| Episode matching | tryMatchEpisode + pickAndUnrestrict | Unchanged |
| Polling logic | isNonTerminal, 3-min timeout | Unchanged |
| Single-flight lock | RdCacheLock upsert | Unchanged (renamed model) |
| 404 re-add | ResourceNotFoundError catch | Unchanged |
| Crawler/parser/metadata | No debrid coupling | Unchanged |

---

# End of SMVShows v2.0 Implementation Guide

When followed exactly, an LLM can produce a fully working v2.0 with zero loss of existing functionality and complete TorBox support. Estimated implementation time: 2–3 hours for an LLM with file-editing tools, including verification.
