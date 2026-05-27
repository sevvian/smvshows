// src/services/debrid/realdebrid.js
const axios = require('axios');
const logger = require('../../utils/logger');
const config = require('../../config/config');

class ResourceNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ResourceNotFoundError';
    }
}

if (!config.isRdEnabled) {
    logger.info('Real-Debrid service is disabled: No API key provided.');
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
} else {
    const rdApi = axios.create({
        baseURL: 'https://api.real-debrid.com/rest/1.0',
        headers: { Authorization: `Bearer ${config.realDebridApiKey}` },
        timeout: 15000
    });

    async function addMagnet(magnet) {
        try {
            const response = await rdApi.post('/torrents/addMagnet', `magnet=${encodeURIComponent(magnet)}`);
            return response.data;
        } catch (error) {
            logger.error({ err: error.response ? error.response.data : error.message, magnet }, 'Failed to add magnet to Real-Debrid.');
            throw error;
        }
    }

    async function getTorrentInfo(id) {
        try {
            const response = await rdApi.get(`/torrents/info/${id}`);
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 404) {
                logger.warn({ rd_id: id }, "getTorrentInfo received a 404. The torrent has likely expired or was invalid.");
                throw new ResourceNotFoundError(`Torrent ID ${id} not found on Real-Debrid.`);
            }
            logger.error({ err: error.response ? error.response.data : error.message }, `Failed to get torrent info for ID: ${id}`);
            throw error;
        }
    }

    async function selectFiles(id, fileIds = 'all') {
        try {
            await rdApi.post(`/torrents/selectFiles/${id}`, `files=${fileIds}`);
            return true;
        } catch (error) {
            if (error.response && error.response.status === 404 && error.response.data?.error_code === 7) {
                logger.warn({ rd_id: id }, "Real-Debrid reported 'unknown_ressource'. The torrent has likely expired or was invalid.");
                throw new ResourceNotFoundError(`Torrent ID ${id} not found on Real-Debrid.`);
            }
            if (error.response && error.response.status === 202) {
                logger.warn(`Files for torrent ID ${id} were already selected.`);
                return true;
            }
            logger.error({ err: error.response ? error.response.data : error.message }, `Failed to select files for torrent ID: ${id}`);
            throw error;
        }
    }

    async function unrestrictLink(link) {
        try {
            const response = await rdApi.post('/unrestrict/link', `link=${link}`);
            return response.data;
        } catch (error) {
            logger.error({ err: error.response ? error.response.data : error.message }, `Failed to unrestrict link: ${link}`);
            throw error;
        }
    }

    async function addAndSelect(magnet) {
        try {
            const addResponse = await rdApi.post('/torrents/addMagnet', `magnet=${encodeURIComponent(magnet)}`);
            const torrentId = addResponse.data.id;
            if (torrentId) {
                await selectFiles(torrentId, 'all');
                return await getTorrentInfo(torrentId);
            }
            return null;
        } catch (error) {
            logger.error({ err: error.response ? error.response.data : error.message }, `Failed during addAndSelect process.`);
            return null;
        }
    }

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
