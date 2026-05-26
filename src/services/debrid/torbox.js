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

    // ── 6. checkCached ────────────────────────────────────────────
    /**
     * Batch-check torrent cache status using TorBox's /checkcached endpoint.
     * @param {string[]} hashes - Array of info hashes to check
     * @returns {Promise<object>} - { [hash]: true | false }
     */
    async function checkCached(hashes) {
        try {
            if (!Array.isArray(hashes) || hashes.length === 0) {
                return {};
            }
            // TorBox checkcached accepts hash as query param (can be repeated)
            const { data } = await tbApi.post('/torrents/checkcached', null, {
                params: { hash: hashes }
            });
            // Normalize: response may be { data: { "hash": true/false } } or directly the object
            const payload = data.data || data;
            const result = {};
            for (const hash of hashes) {
                result[hash] = !!payload[hash];
            }
            return result;
        } catch (error) {
            logger.error({ err: error.response?.data || error.message }, 'Failed to check cached on TorBox.');
            // Return all false on error
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
        ResourceNotFoundError
    };
}
