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

    /**
     * Called by the database layer after models are initialized.
     * Preloads existing torrent_id → hash mappings from the database
     * so that restarts do not cause cache misses.
     */
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
    const torrentIdToHash = new Map();    // numeric id → hash
    const torrentSelections = new Map();  // numeric id → Set<file_id>

    // ── Helpers ───────────────────────────────────────────────────
    async function fetchRawTorrentInfo(numericId) {
        // First try in-memory cache
        let hash = torrentIdToHash.get(numericId);

        // If not in memory, try to recover from DB
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
            params: {
                token: config.torboxApiKey,
                torrent_id: torrentId,
                file_id: fileId,
                redirect: false
            }
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
            const payload = response.data.data || response.data;
            if (payload && payload.id && payload.hash) {
                torrentIdToHash.set(payload.id, payload.hash);
                // Persist mapping to DB for survival across restarts
                if (TorboxIdMap) {
                    try {
                        await TorboxIdMap.upsert({ torrent_id: payload.id, hash: payload.hash });
                    } catch (e) {
                        logger.warn({ torrent_id: payload.id, err: e.message }, 'Failed to persist TorboxIdMap.');
                    }
                }
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

    // ── 6. checkCached ────────────────────────────────────────────
    async function checkCached(hashes) {
        if (!Array.isArray(hashes) || hashes.length === 0) return {};

        try {
            const { data } = await tbApi.post('/torrents/checkcached', null, {
                params: { hash: hashes }
            });
            const payload = data.data || data;
            const result = {};
            for (const hash of hashes) {
                result[hash] = !!payload[hash];
            }
            return result;
        } catch (error) {
            logger.error({ err: error.response?.data || error.message }, 'Failed to check cached on TorBox.');
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
