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
        // checkCached intentionally omitted – triggers DB fallback
        ResourceNotFoundError
    };
}

// ── Unified checkCached ─────────────────────────────────────────
/**
 * Batch-check torrent cache status.
 * If the provider has a native checkCached method, use it for instant results.
 * Otherwise, fall back to the local database.
 *
 * @param {string[]} hashes – Array of info hashes to check
 * @param {object} models – Sequelize models (for DB fallback)
 * @returns {Promise<object>} – { [hash]: true | false }
 */
async function unifiedCheckCached(hashes, models) {
    const provider = getProvider();

    // Path 1: Provider has native checkCached (TorBox)
    if (provider.isEnabled && typeof provider.checkCached === 'function') {
        try {
            const result = await provider.checkCached(hashes);
            logger.debug(`[checkCached] Provider returned instant results.`);
            return result;
        } catch (err) {
            logger.warn({ err: err.message }, '[checkCached] Provider checkCached failed, falling back to DB.');
        }
    }

    // Path 2: Fallback – query local database
    if (models && models.DebridTorrent) {
        const dbResults = {};
        try {
            const records = await models.DebridTorrent.findAll({
                where: { infohash: hashes },
                attributes: ['infohash', 'status']
            });
            for (const record of records) {
                dbResults[record.infohash] = record.status === 'downloaded';
            }
            // Hashes not in DB are not cached
            for (const hash of hashes) {
                if (!(hash in dbResults)) dbResults[hash] = false;
            }
            return dbResults;
        } catch (err) {
            logger.error({ err: err.message }, '[checkCached] DB fallback failed.');
        }
    }

    // Path 3: No provider, no DB – all false
    const empty = {};
    hashes.forEach(h => empty[h] = false);
    return empty;
}

// Proxy so callers can do `debrid.addMagnet(...)` directly
module.exports = new Proxy({}, {
    get(target, prop) {
        if (prop === 'checkCached') {
            return (hashes, models) => unifiedCheckCached(hashes, models);
        }
        // Expose getProvider for health check
        if (prop === 'getProvider') return getProvider;
        const p = getProvider();
        if (prop in p) return p[prop];
        return undefined;
    }
});
