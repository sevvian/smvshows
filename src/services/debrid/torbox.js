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
        setModels: () => {},
        ResourceNotFoundError: class extends Error {
            constructor(m) { super(m); this.name = 'ResourceNotFoundError'; }
        }
    };
} else {
    // ── Axios Instance ────────────────────────────────────────────
    const tbApi = axios.create({
        baseURL: 'https://api.torbox.app/v1/api',
        headers: { Authorization: `Bearer ${config.torboxApiKey}` },
        timeout: 15000
    });

    // ── Persisted Mapping via TorboxIdMap Model ──────────────────
    let TorboxIdMap = null;

    function setModels(models) {
        if (models && models.TorboxIdMap) {
            TorboxIdMap = models.TorboxIdMap;
            TorboxIdMap.findAll().then(rows => {
                rows.forEach(r => torrentIdToHash.set(r.torrent_id, r.hash));
                logger.info(`Loaded ${rows.length} torrent ID→hash mappings from TorboxIdMap.`);
            }).catch(err => logger.warn('Could not preload TorboxIdMap:', err.message));
        }
    }

    // ── In-Memory Caches ──────────────────────────────────────────
    const torrentIdToHash = new Map();
    const torrentSelections = new Map();

    // ── v3.0.1: Rate Limiter & Active Slot Guard ──────────────────
    const addMagnetTimestamps = [];
    const MAX_ADDS_PER_MINUTE = 8;
    const ADD_COOLDOWN_MS = 60_000;

    const recentMagnetAdds = new Map();
    const DEDUP_WINDOW_MS = 30_000;

    function extractInfoHash(magnet) {
        const m = magnet.match(/btih:([a-fA-F0-9]{40})/);
        return m ? m[1].toLowerCase() : null;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Count torrents in "active" states (consuming a download/seeding slot).
     */
    async function getActiveTorrentCount() {
        try {
            const { data } = await tbApi.get('/torrents/mylist');
            const list = data.data || data;
            if (!Array.isArray(list)) return -1;
            const activeStates = new Set([
                'downloading', 'metadl', 'checkingresumedata',
                'stalled (no seeds)', 'uploading', 'seeding'
            ]);
            return list.filter(t => activeStates.has((t.status || '').toLowerCase())).length;
        } catch (e) {
            logger.warn({ err: e.message }, 'Failed to count active torrents via /mylist.');
            return -1;
        }
    }

    /**
     * Enforce the local rate limit for POST /createtorrent.
     */
    function checkAddMagnetRateLimit() {
        const now = Date.now();
        while (addMagnetTimestamps.length > 0 && addMagnetTimestamps[0] < now - ADD_COOLDOWN_MS) {
            addMagnetTimestamps.shift();
        }
        if (addMagnetTimestamps.length >= MAX_ADDS_PER_MINUTE) {
            return false;
        }
        addMagnetTimestamps.push(now);
        return true;
    }

    // ── Helpers ───────────────────────────────────────────────────
    async function fetchRawTorrentInfo(numericId) {
        let hash = torrentIdToHash.get(numericId);
        if (!hash && TorboxIdMap) {
            try {
                const row = await TorboxIdMap.findByPk(numericId);
                if (row) {
                    hash = row.hash;
                    torrentIdToHash.set(numericId, hash);
                }
            } catch (e) {
                logger.warn({ numericId, err: e.message }, 'Failed to recover hash from TorboxIdMap.');
            }
        }
        if (!hash) throw new ResourceNotFoundError(`Torrent ID ${numericId} not found.`);
        const { data } = await tbApi.get('/torrents/torrentinfo', { params: { hash } });
        const payload = data.data || data;
        return payload;
    }

    async function requestDownloadLink(torrentId, fileId) {
        const { data } = await tbApi.get('/torrents/requestdl', {
            params: { token: config.torboxApiKey, torrent_id: torrentId, file_id: fileId, redirect: false }
        });
        const payload = data.data || data;
        return payload.url || payload;
    }

    function mapStatus(tbStatus) {
        const s = (tbStatus || '').toLowerCase();
        if (s === 'downloading' || s === 'metadl' || s === 'checkingresumedata') return 'downloading';
        if (s === 'completed' || s === 'cached' || s === 'uploading' || s === 'seeding') return 'downloaded';
        if (s === 'stalled (no seeds)' || s === 'paused') return 'downloading';
        if (s === 'error' || s === 'failed') return 'error';
        if (s === 'queued') return 'queued';
        return 'queued';
    }

    // ── 1. addMagnet (FIX: accept torbox_id for cached torrents) ──
    async function addMagnet(magnet) {
        const infohash = extractInfoHash(magnet);

        // Dedup: same infohash added within 30 seconds → return existing
        if (infohash && recentMagnetAdds.has(infohash)) {
            const prev = recentMagnetAdds.get(infohash);
            if (Date.now() - prev.timestamp < DEDUP_WINDOW_MS) {
                logger.info({ infohash, torrentId: prev.torrentId }, 'Torrent already added recently; returning existing ID.');
                return { id: prev.torrentId, hash: infohash };
            }
        }

        // Rate limit check
        if (!checkAddMagnetRateLimit()) {
            logger.warn('addMagnet rate limit exceeded (8/min). Rejecting request.');
            throw new Error('TorBox addMagnet rate limit exceeded. Please wait and retry.');
        }

        // Active slot check (optional)
        const maxActive = parseInt(process.env.TORBOX_MAX_ACTIVE_TORRENTS, 10) || 0;
        if (maxActive > 0) {
            const activeCount = await getActiveTorrentCount();
            if (activeCount >= maxActive) {
                logger.warn({ activeCount, maxActive },
                    'TorBox active torrent count at or above limit. Torrent will be queued by TorBox if accepted.');
            }
        }

        // Core API call with retry logic
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                // USE MULTIPART/FORM-DATA
                const form = new FormData();
                form.append('magnet', magnet);

                const response = await tbApi.post('/torrents/createtorrent', form, {
                    headers: form.getHeaders()
                });

                // Log raw response for debugging
                logger.info({ responseData: JSON.stringify(response.data).substring(0, 200) }, 'TorBox createtorrent raw response');

                const payload = response.data.data || response.data;
                // TorBox sometimes returns torrent_id (cached) instead of id.
                const torrentId = payload.torrent_id || payload.id;
                const hash = payload.hash;

                if (torrentId && hash) {
                    torrentIdToHash.set(torrentId, hash);
                    if (TorboxIdMap) {
                        try {
                            await TorboxIdMap.upsert({ torrent_id: torrentId, hash });
                        } catch (e) {
                            logger.warn({ torrent_id: torrentId, err: e.message }, 'Failed to persist TorboxIdMap.');
                        }
                    }
                    if (infohash) {
                        recentMagnetAdds.set(infohash, { timestamp: Date.now(), torrentId });
                    }
                    return { id: torrentId, hash, name: payload.name, ...payload };
                }

                logger.error({
                    rawResponse: JSON.stringify(response.data),
                    message: 'addMagnet response missing id (or torrent_id) / hash'
                }, 'Failed to add magnet to TorBox.');
                lastError = new Error('addMagnet response missing id/hash');
                break;

            } catch (error) {
                logger.error({
                    status: error.response?.status,
                    data: error.response?.data,
                    message: error.message
                }, 'TorBox createtorrent request failed');

                lastError = error;
                const errBody = error.response?.data || {};
                const errCode = errBody.error || '';

                if (errCode === 'ACTIVE_LIMIT') {
                    if (attempt < 2) {
                        const waitMs = 5000 * Math.pow(2, attempt);
                        logger.warn({ errCode, attempt, waitMs }, 'TorBox ACTIVE_LIMIT error. Retrying after backoff.');
                        await sleep(waitMs);
                        continue;
                    }
                }
                if (errCode === 'COOLDOWN_LIMIT') {
                    throw new Error('TorBox cooldown limit reached. Free plan allows 1 download per 24 hours.');
                }
                if (errCode === 'MONTHLY_LIMIT') {
                    throw new Error('TorBox monthly download limit reached (Free plan: 10/month).');
                }
                if (errCode === 'PLAN_RESTRICTED_FEATURE') {
                    throw new Error('This feature is restricted to higher TorBox plans.');
                }
                break;
            }
        }

        logger.error({ err: lastError?.response?.data || lastError?.message, magnet }, 'Failed to add magnet to TorBox.');
        throw lastError || new Error('Failed to add magnet to TorBox.');
    }

    // ── 2. getTorrentInfo ─────────────────────────────────────────
    async function getTorrentInfo(id) {
        try {
            const payload = await fetchRawTorrentInfo(id);
            const tbStatus = mapStatus(payload.status || payload.state);

            const selectedSet = torrentSelections.get(id) || new Set();
            const files = (payload.files || []).map(f => ({
                id: f.id,
                path: f.name,
                bytes: f.size,
                selected: selectedSet.size === 0 || selectedSet.has(f.id) ? 1 : 0
            }));

            const links = [];
            if (tbStatus === 'downloaded') {
                const fileIdsToLink = selectedSet.size > 0
                    ? Array.from(selectedSet)
                    : (payload.files || []).map(f => f.id);
                for (const fid of fileIdsToLink) {
                    try {
                        links.push(await requestDownloadLink(id, fid));
                    } catch (e) {
                        logger.warn({ torrentId: id, fileId: fid, err: e.message }, 'Failed to get download link.');
                        links.push(null);
                    }
                }
            }

            return { id, filename: payload.name, status: tbStatus, files, links };
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
        if (link && (link.startsWith('http://') || link.startsWith('https://'))) {
            return { download: link };
        }
        logger.warn('TorBox does not support hoster link unrestriction.');
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

    // ── 6. checkCached (FIX: robust response parsing) ─────────────
    async function checkCached(hashes) {
        if (!Array.isArray(hashes) || hashes.length === 0) return {};

        try {
            const { data } = await tbApi.post('/torrents/checkcached', null, {
                params: { hash: hashes }
            });

            // TorBox may nest data under 'data' or return it at top level.
            let payload = data.data || data;
            // If it's an array (unlikely but handled), take the first element.
            if (Array.isArray(payload)) {
                payload = payload[0] || {};
            }

            const result = {};
            for (const hash of hashes) {
                const value = payload[hash];
                // value could be a boolean, or an object (e.g., { size: 12345 }) – treat any truthy as cached
                result[hash] = typeof value === 'object' ? true : !!value;
            }

            logger.debug(
                { hashCount: hashes.length, cachedCount: Object.values(result).filter(Boolean).length },
                'TorBox checkCached result'
            );
            return result;

        } catch (error) {
            logger.error({ err: error.response?.data || error.message }, 'Failed to check cached on TorBox.');
            // On complete failure, mark all as not cached (safer than showing false ⚡)
            const empty = {};
            hashes.forEach(h => empty[h] = false);
            return empty;
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
        checkCached,
        setModels,
        ResourceNotFoundError
    };
}
