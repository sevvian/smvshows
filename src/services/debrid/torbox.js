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

        logger.info({ torrentId: numericId, hash }, 'Requesting torrent info from TorBox...');
        const { data } = await tbApi.get('/torrents/torrentinfo', { params: { hash } });
        logger.info({ torrentinfoFullResponse: JSON.stringify(data).substring(0, 2000) }, 'TorBox torrentinfo FULL raw response');
        const payload = data.data || data;
        return payload;
    }

    async function fetchTorrentStatus(torrentId) {
        try {
            logger.info({ torrentId }, 'Requesting torrent status from TorBox via /mylist...');
            const { data } = await tbApi.get('/torrents/mylist', { params: { id: torrentId } });
            logger.info({ mylistResponse: JSON.stringify(data).substring(0, 500) }, 'TorBox mylist raw response for single ID');
            const list = data.data || data;
            const item = Array.isArray(list) ? list[0] : list;
            const rawStatus = item ? (item.download_state || item.status || 'MISSING') : 'MISSING';
            logger.info({ torrentId, rawStatus }, 'TorBox torrent status retrieved');
            return rawStatus;
        } catch (error) {
            logger.warn({ torrentId, err: error.message }, 'Failed to fetch torrent status via /mylist, falling back to MISSING');
            return 'MISSING';
        }
    }

    async function requestDownloadLink(torrentId, fileId) {
        logger.info({ torrentId, fileId }, 'Requesting download link from TorBox...');
        const { data } = await tbApi.get('/torrents/requestdl', {
            params: { token: config.torboxApiKey, torrent_id: torrentId, file_id: fileId, redirect: false }
        });
        logger.info({ requestdlResponse: JSON.stringify(data).substring(0, 300) }, 'TorBox requestdl raw response');
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

    // ── 2. getTorrentInfo (retains full file list for DB snapshot) ─
    async function getTorrentInfo(id) {
        try {
            const payload = await fetchRawTorrentInfo(id);
            const rawStatus = await fetchTorrentStatus(id);
            const tbStatus = mapStatus(rawStatus);

            const selectedSet = torrentSelections.get(id) || new Set();
            const files = (payload.files || []).map((f, idx) => ({
                id: idx,                    // array index is the file_id
                path: f.name,
                bytes: f.size,
                selected: selectedSet.size === 0 || selectedSet.has(idx) ? 1 : 0
            }));

            const links = [];
            // We still populate the links array so the DB snapshot is complete,
            // but we no longer generate all links eagerly during polling.
            // The actual download URL for a specific episode is obtained via getDownloadLinkForFile.
            if (tbStatus === 'downloaded' && payload.files) {
                // Fill the array with null placeholders (will be replaced when needed)
                payload.files.forEach(() => links.push(null));
            }

            return { id, filename: payload.name, status: tbStatus, files, links };
        } catch (error) {
            if (error instanceof ResourceNotFoundError) throw error;
            if (error.response?.status === 404) throw new ResourceNotFoundError(`Torrent ID ${id} not found on TorBox.`);
            throw error;
        }
    }

    // ── 3. selectFiles ────────────────────────────────────────────
    async function selectFiles(id, fileIds = 'all') {
        try {
            if (fileIds === 'all') {
                const info = await fetchRawTorrentInfo(id);
                const allIds = (info.files || []).map((_, idx) => idx);
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

    // ── 6. checkCached ────────────────────────────────────────────
    async function checkCached(hashes) {
        if (!Array.isArray(hashes) || hashes.length === 0) return {};
        try {
            const { data } = await tbApi.post('/torrents/checkcached', null, { params: { hash: hashes } });
            logger.info({ checkCachedResponse: JSON.stringify(data).substring(0, 300) }, 'TorBox checkCached raw response');
            let payload = data.data || data;
            if (Array.isArray(payload)) payload = payload[0] || {};
            const result = {};
            for (const hash of hashes) {
                const value = payload[hash];
                result[hash] = typeof value === 'object' ? true : !!value;
            }
            return result;
        } catch (error) {
            logger.error({ err: error.message }, 'Failed to check cached on TorBox.');
            return {};
        }
    }

    // ── 7. getDownloadLinkForFile (NEW – single file download) ──
    async function getDownloadLinkForFile(torrentId, fileId) {
        logger.info({ torrentId, fileId }, 'Requesting single file download link from TorBox...');
        const { data } = await tbApi.get('/torrents/requestdl', {
            params: {
                token: config.torboxApiKey,
                torrent_id: torrentId,
                file_id: fileId,
                redirect: false
            }
        });
        logger.info({ requestdlResponse: JSON.stringify(data).substring(0, 300) }, 'TorBox single requestdl raw response');
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
        setModels,
        getDownloadLinkForFile,
        ResourceNotFoundError
    };
}
