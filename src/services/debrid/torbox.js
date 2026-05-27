// src/services/debrid/torbox.js
const axios = require('axios');
const FormData = require('form-data');
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
    module.exports = {
        isEnabled: false,
        addMagnet: async () => { throw new Error('TorBox is disabled.'); },
        getTorrentInfo: async () => { throw new Error('TorBox is disabled.'); },
        selectFiles: async () => { throw new Error('TorBox is disabled.'); },
        unrestrictLink: async () => { throw new Error('TorBox is disabled.'); },
        addAndSelect: async () => { throw new Error('TorBox is disabled.'); },
        checkCached: async () => { throw new Error('TorBox is disabled.'); },
        getCachedFileInfo: async () => { throw new Error('TorBox is disabled.'); },
        getDownloadLinkForFile: async () => { throw new Error('TorBox is disabled.'); },
        setModels: () => {},
        ResourceNotFoundError: class extends Error {
            constructor(m) { super(m); this.name = 'ResourceNotFoundError'; }
        }
    };
} else {
    // ── Axios Instance (timeout 30s) ─────────────────────────────
    const tbApi = axios.create({
        baseURL: 'https://api.torbox.app/v1/api',
        headers: { Authorization: `Bearer ${config.torboxApiKey}` },
        timeout: 30000
    });

    // ── Persisted Mapping via TorboxIdMap Model ──────────────────
    let TorboxIdMap = null;
    let localDebridTorrentModel = null;

    function setModels(models) {
        if (models && models.TorboxIdMap) {
            TorboxIdMap = models.TorboxIdMap;
            TorboxIdMap.findAll().then(rows => {
                rows.forEach(r => torrentIdToHash.set(r.torrent_id, r.hash));
                logger.info(`Loaded ${rows.length} torrent ID→hash mappings from TorboxIdMap.`);
            }).catch(err => logger.warn('Could not preload TorboxIdMap:', err.message));
        }
        if (models && models.DebridTorrent) {
            localDebridTorrentModel = models.DebridTorrent;
            logger.info('TorBox provider now has access to the local DebridTorrent model.');
        }
    }

    // ── In-Memory Caches ──────────────────────────────────────────
    const torrentIdToHash = new Map();
    const torrentSelections = new Map();

    // ── Rate Limiter & Dedup ─────────────────────────────────────
    const addMagnetTimestamps = [];
    const MAX_ADDS_PER_MINUTE = 8;
    const ADD_COOLDOWN_MS = 60_000;
    const recentMagnetAdds = new Map();
    const DEDUP_WINDOW_MS = 30_000;

    function extractInfoHash(magnet) {
        const m = magnet.match(/btih:([a-fA-F0-9]{40})/);
        return m ? m[1].toLowerCase() : null;
    }
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
    function checkAddMagnetRateLimit() {
        const now = Date.now();
        while (addMagnetTimestamps.length > 0 && addMagnetTimestamps[0] < now - ADD_COOLDOWN_MS)
            addMagnetTimestamps.shift();
        if (addMagnetTimestamps.length >= MAX_ADDS_PER_MINUTE) return false;
        addMagnetTimestamps.push(now);
        return true;
    }

    // ── Active Slot Management ───────────────────────────────────
    const ACTIVE_STATES = new Set([
        'downloading', 'metadl', 'checkingresumedata',
        'stalled (no seeds)', 'uploading', 'seeding'
    ]);
    const STALE_STATES = new Set([
        'stalled (no seeds)', 'paused', 'error', 'failed', 'missingfiles', 'expired'
    ]);

    async function getActiveTorrentCount() {
        try {
            const { data } = await tbApi.get('/torrents/mylist');
            const list = data.data || data;
            if (!Array.isArray(list)) return { count: -1, staleList: [] };
            const active = list.filter(t => ACTIVE_STATES.has((t.status || '').toLowerCase()));
            const stale = active.filter(t => STALE_STATES.has((t.status || '').toLowerCase()));
            return { count: active.length, staleList: stale.map(t => t.id) };
        } catch (e) {
            logger.warn({ err: e.message }, 'Failed to count active torrents via /mylist.');
            return { count: -1, staleList: [] };
        }
    }

    async function deleteTorrent(torrentId) {
        try {
            logger.info({ torrentId }, 'Deleting torrent from TorBox...');
            const form = new FormData();
            form.append('id', torrentId);
            form.append('action', 'delete');
            const response = await tbApi.post('/torrents/controltorrent', form, {
                headers: form.getHeaders()
            });
            return true;
        } catch (error) {
            logger.warn({ torrentId, err: error.message }, 'Failed to delete torrent from TorBox.');
            return false;
        }
    }

    async function cleanupStaleActiveTorrents(maxActive) {
        if (maxActive <= 0) return;
        const { count, staleList } = await getActiveTorrentCount();
        if (count < 0 || count < maxActive) return;
        const needToRemove = count - maxActive + 1;
        const toRemove = staleList.slice(0, Math.min(needToRemove, staleList.length));
        if (toRemove.length === 0) {
            logger.warn({ activeCount: count, maxActive },
                'All active torrent slots are full and no stale torrents to remove.');
            return;
        }
        logger.info({ activeCount: count, maxActive, removing: toRemove },
            'Cleaning up stale active torrents to make room.');
        for (const id of toRemove) {
            await deleteTorrent(id);
            torrentIdToHash.delete(id);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────
    /**
     * Fetch the full torrent info (including real file IDs) from the user's
     * torrent list. Replaces the old /torrentinfo call.
     */
    async function fetchFullTorrentInfo(torrentId) {
        logger.info({ torrentId }, 'Requesting torrent details from TorBox via /mylist...');
        const { data } = await tbApi.get('/torrents/mylist', {
            params: { id: torrentId }
        });
        logger.info({ mylistFullResponse: JSON.stringify(data).substring(0, 2000) }, 'TorBox mylist full response');
        const list = data.data || data;
        // The API returns a single object when ?id= is given
        const item = Array.isArray(list) ? list[0] : list;
        if (!item) throw new ResourceNotFoundError(`Torrent ID ${torrentId} not found in user list.`);
        return item;
    }

    async function requestDownloadLink(torrentId, fileId) {
        logger.info({ torrentId, fileId }, 'Requesting download link from TorBox...');
        const { data } = await tbApi.get('/torrents/requestdl', {
            params: { token: config.torboxApiKey, torrent_id: torrentId, file_id: fileId, redirect: false }
        });
        const payload = data.data || data;
        return payload.url || payload;
    }

    function mapStatus(tbStatus) {
        const s = (tbStatus || '').toLowerCase();
        if (['completed', 'cached', 'uploading', 'seeding', 'active', 'downloaded'].includes(s)) return 'downloaded';
        if (['downloading', 'metadl', 'checkingresumedata', 'stalled', 'queued'].includes(s)) return 'downloading';
        if (['error', 'failed', 'missingfiles', 'expired'].includes(s)) return 'error';
        return 'downloading';
    }

    // ── 1. addMagnet ──────────────────────────────────────────────
    async function addMagnet(magnet) {
        const infohash = extractInfoHash(magnet);
        if (infohash && recentMagnetAdds.has(infohash)) {
            const prev = recentMagnetAdds.get(infohash);
            if (Date.now() - prev.timestamp < DEDUP_WINDOW_MS) {
                logger.info({ infohash, torrentId: prev.torrentId }, 'Torrent already added recently; returning existing ID.');
                return { id: prev.torrentId, hash: infohash, cached: true };
            }
        }
        if (!checkAddMagnetRateLimit()) {
            logger.warn('addMagnet rate limit exceeded (8/min). Rejecting request.');
            throw new Error('TorBox addMagnet rate limit exceeded. Please wait and retry.');
        }

        const maxActive = parseInt(process.env.TORBOX_MAX_ACTIVE_TORRENTS, 10) || 0;
        if (maxActive > 0) {
            await cleanupStaleActiveTorrents(maxActive);
        }

        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const form = new FormData();
                form.append('magnet', magnet);
                const response = await tbApi.post('/torrents/createtorrent', form, { headers: form.getHeaders() });
                logger.info({ responseData: JSON.stringify(response.data).substring(0, 300) }, 'TorBox createtorrent raw response');
                const payload = response.data.data || response.data;
                const torrentId = payload.torrent_id || payload.id;
                const hash = payload.hash;
                const detail = (response.data.detail || '').toLowerCase();
                const isCachedTorrent = detail.includes('cached torrent') || detail.includes('found cached');

                if (torrentId && hash) {
                    torrentIdToHash.set(torrentId, hash);
                    if (TorboxIdMap) {
                        try { await TorboxIdMap.upsert({ torrent_id: torrentId, hash }); } catch (e) {}
                    }
                    if (infohash) recentMagnetAdds.set(infohash, { timestamp: Date.now(), torrentId });
                    if (isCachedTorrent && infohash && localDebridTorrentModel) {
                        try {
                            await localDebridTorrentModel.upsert({
                                infohash, torrent_id: String(torrentId), provider: 'torbox',
                                status: 'downloaded', last_checked: new Date()
                            });
                            logger.info({ infohash, torrentId }, 'Marked cached torrent as downloaded in local DB.');
                        } catch (e) {}
                    }
                    return { id: torrentId, hash, name: payload.name, cached: isCachedTorrent, ...payload };
                }
                logger.error({ rawResponse: JSON.stringify(response.data) }, 'addMagnet response missing id/hash');
                lastError = new Error('addMagnet response missing id/hash');
                break;
            } catch (error) {
                logger.error({ status: error.response?.status, data: error.response?.data }, 'TorBox createtorrent request failed');
                lastError = error;
                const errCode = (error.response?.data || {}).error || '';
                if (errCode === 'ACTIVE_LIMIT') {
                    if (attempt < 2) { await sleep(5000 * Math.pow(2, attempt)); continue; }
                }
                break;
            }
        }
        throw lastError || new Error('Failed to add magnet to TorBox.');
    }

    // ── 2. getTorrentInfo (now uses mylist, returns real file IDs) ─
    async function getTorrentInfo(id) {
        try {
            const torrent = await fetchFullTorrentInfo(id);
            const rawStatus = torrent.download_state || torrent.status || 'MISSING';
            const tbStatus = mapStatus(rawStatus);

            const selectedSet = torrentSelections.get(id) || new Set();
            // files now contain the real file ID from TorBox
            const files = (torrent.files || []).map(f => ({
                id: f.id,                      // ← real file ID
                path: f.name,
                bytes: f.size,
                selected: selectedSet.size === 0 || selectedSet.has(f.id) ? 1 : 0
            }));

            const links = [];
            if (tbStatus === 'downloaded' && torrent.files) {
                torrent.files.forEach(() => links.push(null));  // placeholder
            }

            return { id, filename: torrent.name, status: tbStatus, files, links };
        } catch (error) {
            if (error instanceof ResourceNotFoundError) throw error;
            if (error.response?.status === 404) throw new ResourceNotFoundError(`Torrent ID ${id} not found on TorBox.`);
            throw error;
        }
    }

    // ── 3. selectFiles (now uses real file IDs) ──────────────────
    async function selectFiles(id, fileIds = 'all') {
        try {
            const torrent = await fetchFullTorrentInfo(id);
            if (fileIds === 'all') {
                const allIds = (torrent.files || []).map(f => f.id);
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
            throw error;
        }
    }

    // ── 4. unrestrictLink ─────────────────────────────────────────
    async function unrestrictLink(link) {
        if (link && (link.startsWith('http://') || link.startsWith('https://'))) return { download: link };
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
            logger.error({ err: error.message }, 'Failed during addAndSelect process.');
            return null;
        }
    }

    // ── 6. checkCached (POST with JSON body, as before) ──────────
    async function checkCached(hashes) {
        if (!Array.isArray(hashes) || hashes.length === 0) return {};

        const body = { hashes };
        const params = {
            format: 'object',
            list_files: true
        };

        logger.info({ url: '/torrents/checkcached', body }, 'TorBox checkCached request');

        try {
            const response = await tbApi.post('/torrents/checkcached', body, { params });
            const data = response.data;
            logger.info({ checkCachedResponse: JSON.stringify(data).substring(0, 2000) }, 'TorBox checkCached raw response');

            let payload = data.data || data;
            if (Array.isArray(payload)) payload = payload[0] || {};

            const result = {};
            for (const hash of hashes) {
                const value = payload[hash];
                if (typeof value === 'object' && value !== null) {
                    result[hash] = {
                        cached: true,
                        name: value.name,
                        size: value.size,
                        files: value.files || []
                    };
                } else {
                    result[hash] = { cached: !!value, files: [] };
                }
            }

            const cachedCount = Object.values(result).filter(v => v.cached).length;
            logger.info({ hashCount: hashes.length, cachedCount }, 'TorBox checkCached result');
            return result;

        } catch (error) {
            logger.error({ err: error.message }, 'Failed to check cached on TorBox.');
            const empty = {};
            hashes.forEach(h => empty[h] = { cached: false, files: [] });
            return empty;
        }
    }

    // ── 7. getCachedFileInfo (match by name) ──────────────────────
    async function getCachedFileInfo(hash, fileName) {
        const cacheResult = await checkCached([hash]);
        const info = cacheResult[hash];
        if (!info || !info.cached || !Array.isArray(info.files)) return null;

        const file = info.files.find(f => f.name.endsWith(fileName) || f.name === fileName);
        if (!file) return null;

        logger.info({
            hash,
            fileName,
            fileId: file.id,
            matchedFile: file.name
        }, 'TorBox getCachedFileInfo matched by name');

        return {
            id: file.id,
            path: file.name,
            bytes: file.size,
            torrentName: info.name,
            torrentSize: info.size
        };
    }

    // ── 8. getDownloadLinkForFile ─────────────────────────────────
    async function getDownloadLinkForFile(torrentId, fileId) {
        logger.info({ torrentId, fileId }, 'Requesting single file download link from TorBox...');
        const { data } = await tbApi.get('/torrents/requestdl', {
            params: { token: config.torboxApiKey, torrent_id: torrentId, file_id: fileId, redirect: false }
        });
        const payload = data.data || data;
        return payload.url || payload;
    }

    // ── Export ────────────────────────────────────────────────────
    module.exports = {
        isEnabled: true,
        addMagnet,
        getTorrentInfo,
        selectFiles,
        unrestrictLink,
        addAndSelect,
        checkCached,
        getCachedFileInfo,
        setModels,
        getDownloadLinkForFile,
        ResourceNotFoundError
    };
}
