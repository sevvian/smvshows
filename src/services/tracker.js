const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/config');

// In-memory cache for the tracker list
let cachedTrackers = [];

// Minimal curated fallback list (kept very small to save memory and still be reliable)
const FALLBACK_TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://open.stealth.si:80/announce',
    'udp://opentracker.i2p.rocks:6969/announce'
];

/**
 * Fetches the list of trackers from the configured URL and updates the cache.
 */
async function fetchAndCacheTrackers() {
    logger.info(`Fetching latest trackers from: ${config.trackerUrl}`);
    try {
        const response = await axios.get(config.trackerUrl, { timeout: 10000 });
        if (response.data) {
            const trackers = response.data
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));

            if (trackers.length > 0) {
                cachedTrackers = trackers;
                logger.info(`Successfully cached ${trackers.length} trackers.`);
                return;
            }
            logger.warn('Fetched tracker list was empty. Falling back to minimal list.');
        }
    } catch (error) {
        logger.error({ err: error.message }, 'Failed to fetch tracker list. Falling back to minimal list.');
    }
    // Fallback if fetch failed or returned an empty list
    cachedTrackers = FALLBACK_TRACKERS.slice();
}

/**
 * Returns the current list of cached trackers.
 * @returns {string[]} An array of tracker URLs.
 */
function getTrackers() {
    if (!cachedTrackers || cachedTrackers.length === 0) {
        // Ensure we never return an empty array
        cachedTrackers = FALLBACK_TRACKERS.slice();
    }
    return cachedTrackers;
}

module.exports = {
    fetchAndCacheTrackers,
    getTrackers,
};