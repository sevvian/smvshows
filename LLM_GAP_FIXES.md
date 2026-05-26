1. ⚠️ Critical: orchestrator.js and other files may still reference RdTorrent / rd_id / realdebrid
Problem
The guide states “The orchestrator only references MagnetCache, which is unchanged. No edits needed.” This is almost certainly false. The orchestrator coordinates scraping, linking, and debrid caching—it’s where magnets are submitted to the debrid service and where the results are stored. In the original code orchestrator.js calls rd.addAndSelect(magnet) and then upserts into RdTorrent (table rd_torrents), using rd_id as the column name. If you rename the table to debrid_torrents, the column to torrent_id, and the model to DebridTorrent, the orchestrator will crash.

Fix
Search the entire codebase for:

RdTorrent

RdCacheLock

rd_id

require('../services/realdebrid')

Update every occurrence:

models.RdTorrent → models.DebridTorrent

models.RdCacheLock → models.DebridCacheLock

rd_id property → torrent_id

require('../services/realdebrid') → require('../services/debrid') (if it imports the debrid module directly)

Example in orchestrator.js:

javascript
// Old (hypothetical)
const rd = require('../services/realdebrid');
const result = await rd.addAndSelect(magnet);
await models.RdTorrent.upsert({ infohash, rd_id: result.id, status: result.status });
New:

javascript
const debrid = require('../services/debrid');
const result = await debrid.addAndSelect(magnet);
await models.DebridTorrent.upsert({ infohash, torrent_id: result.id, status: result.status, provider: config.debridService });
2. ⚠️ Critical: services/debrid/realdebrid.js disabled export is incomplete
Problem
When config.isRdEnabled is false, the RD module only exports { isEnabled: false }. If the factory selects 'realdebrid' but the key is missing, the Proxy will later return undefined for addMagnet, getTorrentInfo, etc. Routes already check isEnabled before calling, so it’s technically safe. However, if any code accidentally calls a method without checking, it will throw TypeError: debrid.addMagnet is not a function. That’s a fragile design.

Fix
Make the disabled module export all functions (they can throw an error). This matches the disabled stub in index.js. Update realdebrid.js:

javascript
if (!config.isRdEnabled) {
    module.exports = {
        isEnabled: false,
        addMagnet: async () => { throw new Error('Real-Debrid is disabled.'); },
        getTorrentInfo: async () => { throw new Error('Real-Debrid is disabled.'); },
        selectFiles: async () => { throw new Error('Real-Debrid is disabled.'); },
        unrestrictLink: async () => { throw new Error('Real-Debrid is disabled.'); },
        addAndSelect: async () => { throw new Error('Real-Debrid is disabled.'); },
        ResourceNotFoundError: class extends Error {
            constructor(m) { super(m); this.name = 'ResourceNotFoundError'; }
        }
    };
}
3. 🔴 In-memory caches cause ResourceNotFoundError on every restart for TorBox
Problem
torrentIdToHash and torrentSelections are cleared when the process restarts. The DB stores torrent_id (numeric). When stremio.routes.js later calls debrid.getTorrentInfo(rdId), the TorBox provider looks up torrentIdToHash.get(id) and gets undefined → throws ResourceNotFoundError. The error handler then re-adds the magnet via addMagnet, which:

May create a duplicate torrent on TorBox (if the hash is already added, TorBox returns the existing torrent ID, but the cache is repopulated anyway).

Works, but is wasteful and slow.

Causes a storm of re-adds on cold start.

Fix
In torbox.js getTorrentInfo, if the hash is not in the cache, try to recover by querying /mylist or by calling addMagnet automatically. Better still, persist the mapping in the database (a new table torbox_id_map). Since you’re doing a clean v2.0, add a simple table:

sql
CREATE TABLE IF NOT EXISTS torbox_id_map (
    torrent_id INTEGER PRIMARY KEY,
    hash TEXT NOT NULL
);
Then in torbox.js, after addMagnet (or when restoring from DB), load the mapping. This eliminates the restart problem.

4. 🔴 unifiedCheckCached in factory passes models but TorBox doesn't need them
Problem
In index.js, the checkCached proxy returns (hashes, models) => unifiedCheckCached(hashes, models). When using TorBox, unifiedCheckCached calls provider.checkCached(hashes) without models. That’s fine. However, if provider.checkCached fails, it falls back to the DB path, which requires models. The fallback logic already has models because we passed them into unifiedCheckCached. So no runtime error, but the signature debrid.checkCached(hashes, models) is inconsistent for TorBox users (they must supply models even though they aren't used). Better to make models optional and only use it when falling back.

Fix
Keep as is—it’s not breaking. But document that models is required for RD but can be null for TorBox. In stremio.routes.js, always pass models.

5. ⚠️ admin.routes.js health endpoint returns debridCacheCheck based on typeof debrid.checkCached
Problem
The factory’s Proxy always exposes a checkCached function, so typeof debrid.checkCached === 'function' is always true, even when the underlying provider (RD) doesn't have it. This means the health endpoint would incorrectly report 'instant' for RD.

Fix
In the health handler, use:

javascript
const provider = require('../services/debrid').getProvider(); // expose getProvider or check the actual loaded module
const hasInstantCheck = provider && typeof provider.checkCached === 'function';
debridCacheCheck: hasInstantCheck ? 'instant' : 'database'
Better: export getProvider from the factory (remove the Proxy or add a named export). Or store the provider reference and compare.

6. 🔴 TorBox checkCached response normalization may fail
Problem
The code does:

javascript
const payload = response.data.data || response.data;
If the API returns { "success": true, "data": { "hash1": true } }, then response.data is { success: true, data: { hash1: true } }. response.data.data is the inner map—correct. But if the API returns only { "hash1": true } (some versions do), then response.data is that object, response.data.data is undefined, and || response.data gives the correct map. So it works. However, we also loop Object.entries(payload) to build result. That’s fine.

But there is a subtle bug: if the API returns { "success": true, "data": {} } (empty cache), payload becomes {}, and the loop correctly returns {}. Good.

7. ⚠️ Batch cache check in stremio.routes.js may miss newly added torrents
Problem
The stream endpoint calls debrid.checkCached(allHashes, models) once at the top. Later in the loop, when it encounters an uncached torrent, it calls addAndSelect (re-add). That will eventually make it cached, but the cacheStatus map won't reflect the new status until the next request. This is identical to the old per-hash behavior (because the old code also checked once). So no regression.

8. 🔴 config.js auto-detection uses console.warn without importing logger
Problem
The config file uses console.warn for the warning. That’s acceptable, but the rest of the app uses pino. The guide says to optionally import logger. It’s cleaner to use the logger if available, but console.warn works. Not breaking.

9. 🔴 Missing update to Dockerfile or package.json? No, but check for references to old file paths
Search the whole repo for services/realdebrid in Dockerfile, startup scripts, or tests. None expected, but verify.

10. 🔴 torbox.js unrestrictLink returns { download: link } for URLs — but link may not be a direct download if passed from other code paths
The only caller is stremio.routes.js with rdTorrent.links[linkIndex], which are guaranteed to be direct-download URLs. Safe.

11. 🔴 stremio.routes.js field renaming of rd_id might break MagnetCache reference
No, MagnetCache is separate. The Stream model stores infohash, not rd_id. Good.

12. 🔴 services/debrid/realdebrid.js still imports config as ../config/config; but the path from services/debrid/ is ../../config/config — already fixed in guide. Good.
13. 🔴 TorBox addMagnet returns the whole payload; original RD returns response.data which has id. That’s compatible.
✅ Final Checklist for a Break-Free v2.0
Find and update all references to RdTorrent, RdCacheLock, rd_id, realdebrid in every file (especially orchestrator.js, stremio.routes.js, admin.routes.js, index.js).

Make the disabled RD provider export all functions (just like the disabled stub).

Add torbox_id_map table or persist the hash-id mapping to avoid restart storms.

Fix the health endpoint so it reports instant cache only for providers that actually export checkCached.

Run the interface and integration tests after every change.

With these corrections, the v2.0 abstraction is robust and truly production-ready. I’d be happy to provide the corrected version of the full guide if you need it.
