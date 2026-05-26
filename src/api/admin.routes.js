const express = require('express');
const router = express.Router();
const { runFullWorkflow, getDashboardCache, updateDashboardCache, isCrawling } = require('../services/orchestrator');
const { models } = require('../database/connection');
const metadata = require('../services/metadata');
const parser = require('../services/parser');
const crud = require('../database/crud');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const debrid = require('../services/debrid');
const { Op } = require('sequelize');

// Trigger the main workflow
router.post('/trigger-crawl', (req, res) => {
    runFullWorkflow();
    res.status(202).json({ message: 'Crawl workflow triggered successfully. Check logs for progress.' });
});

// Dashboard: cached stats; compute once if empty
router.get('/dashboard', async (req, res) => {
    try {
        const cache = getDashboardCache();
        if (!cache.lastUpdated) await updateDashboardCache();
        return res.json(getDashboardCache());
    } catch (e) {
        logger.error(e, 'Dashboard endpoint failed; returning live counts as fallback.');
        const linked = await models.Thread.count({ where: { status: 'linked' } });
        const pending = await models.Thread.count({ where: { status: 'pending_tmdb' } });
        const failed = await models.FailedThread.count();
        return res.json({ linked, pending, failed, lastUpdated: new Date() });
    }
});

// List pending items
router.get('/pending', async (req, res) => {
    try {
        const pendingThreads = await models.Thread.findAll({
            where: { status: 'pending_tmdb' },
            order: [['updatedAt', 'DESC']],
        });
        res.json(pendingThreads);
    } catch (error) {
        logger.error(error, 'Failed to fetch pending threads.');
        res.status(500).json({ message: 'Error fetching pending threads.' });
    }
});

// Parsed streams for a pending thread + lock info
router.get('/pending/:threadId/streams', async (req, res) => {
    const { threadId } = req.params;
    try {
        const thread = await models.Thread.findByPk(threadId);
        if (!thread || thread.status !== 'pending_tmdb' || !Array.isArray(thread.magnet_uris) || thread.magnet_uris.length === 0) {
            return res.status(404).json({ message: 'Pending thread with magnets not found.' });
        }
        const items = [];
        for (const magnet of thread.magnet_uris) {
            const p = parser.parseMagnet(magnet, thread.type);
            if (!p) continue;
            const label = thread.type === 'movie'
                ? `${p.quality || 'SD'}${p.language ? ' • ' + p.language : ''}`
                : (() => {
                    let epStr = '';
                    if (p.type === 'SEASON_PACK') epStr = 'Season Pack';
                    else if (p.type === 'EPISODE_PACK') epStr = `E${p.episodeStart}-${p.episodeEnd}`;
                    else epStr = `E${p.episode}`;
                    return `S${String(p.season).padStart(2, '0')} ${epStr} • ${p.quality || 'SD'}${p.language ? ' • ' + p.language : ''}`;
                })();
            items.push({
                infohash: p.infohash,
                type: p.type,
                season: p.season || null,
                episode: p.episode || null,
                episodeStart: p.episodeStart || null,
                episodeEnd: p.episodeEnd || null,
                quality: p.quality || null,
                language: p.language || null,
                label
            });
        }
        const locks = await models.DebridCacheLock.findAll({
            where: { infohash: { [Op.in]: items.map(i => i.infohash) } },
            raw: true
        });
        const locked = new Set(locks.map(l => l.infohash));
        res.json({ items, locked: Array.from(locked) });
    } catch (error) {
        logger.error(error, 'Failed to fetch parsed streams for pending item.');
        res.status(500).json({ message: 'Error fetching streams.' });
    }
});

// List critical parse failures
router.get('/failures', async (req, res) => {
    try {
        const failedThreads = await models.FailedThread.findAll({
            order: [['last_attempt', 'DESC']],
        });
        res.json(failedThreads);
    } catch (error) {
        logger.error(error, 'Failed to fetch failures.');
        res.status(500).json({ message: 'Error fetching critical failures.' });
    }
});

// Update custom poster / description
router.post('/custom-meta', async (req, res) => {
    const { threadId, poster, description } = req.body || {};
    if (!threadId) return res.status(400).json({ message: 'threadId is required.' });
    try {
        const thread = await models.Thread.findByPk(threadId);
        if (!thread) return res.status(404).json({ message: 'Thread not found.' });
        if (poster !== undefined) thread.custom_poster = poster;
        if (description !== undefined) thread.custom_description = description;
        await thread.save();
        res.json({ message: 'Custom metadata saved.' });
    } catch (error) {
        logger.error(error, 'custom-meta failed');
        res.status(500).json({ message: 'Error saving custom metadata.' });
    }
});

// Link a pending thread to an official ID
router.post('/link-official', async (req, res) => {
    const { threadId, officialId } = req.body || {};
    if (!threadId || !officialId) return res.status(400).json({ message: 'threadId and officialId are required.' });
    try {
        const thread = await models.Thread.findByPk(threadId);
        if (!thread || thread.status !== 'pending_tmdb') {
            return res.status(404).json({ message: 'Pending thread not found.' });
        }
        const newData = await metadata.getTmdbMetadataById(officialId);
        if (!newData || !newData.dbEntry) {
            return res.status(400).json({ message: `Could not resolve ID: ${officialId}` });
        }
        const { dbEntry } = newData;
        await models.TmdbMetadata.upsert(dbEntry);
        const streamsToCreate = [];
        for (const magnet_uri of (thread.magnet_uris || [])) {
            const parsed = parser.parseMagnet(magnet_uri, thread.type);
            if (!parsed) continue;
            let streamEntry = {
                tmdb_id: dbEntry.tmdb_id,
                infohash: parsed.infohash,
                quality: parsed.quality,
                language: parsed.language
            };
            if (thread.type === 'series' && parsed.season) {
                streamEntry.season = parsed.season;
                if (parsed.type === 'SEASON_PACK') {
                    streamEntry.episode = 1;
                    streamEntry.episode_end = 999;
                } else if (parsed.type === 'EPISODE_PACK') {
                    streamEntry.episode = parsed.episodeStart;
                    streamEntry.episode_end = parsed.episodeEnd;
                } else if (parsed.type === 'SINGLE_EPISODE') {
                    streamEntry.episode = parsed.episode;
                    streamEntry.episode_end = parsed.episode;
                }
            } else if (thread.type === 'movie') {
                streamEntry.season = null;
                streamEntry.episode = null;
            }
            streamsToCreate.push(streamEntry);
        }
        if (streamsToCreate.length > 0) {
            await models.Stream.bulkCreate(streamsToCreate, { ignoreDuplicates: true });
        }
        thread.tmdb_id = dbEntry.tmdb_id;
        thread.status = 'linked';
        thread.magnet_uris = null;
        await thread.save();
        await updateDashboardCache();
        res.json({ message: `Linked "${thread.clean_title}" and created ${streamsToCreate.length} stream(s).` });
    } catch (error) {
        logger.error(error, 'link-official failed.');
        res.status(500).json({ message: 'Internal error during link.' });
    }
});

// Correct a mislinked item
router.post('/correct-link', async (req, res) => {
    const { currentImdbId, correctId } = req.body || {};
    if (!currentImdbId || !correctId) {
        return res.status(400).json({ message: 'Both currentImdbId and correctId are required.' });
    }
    try {
        const oldMeta = await models.TmdbMetadata.findOne({ where: { imdb_id: currentImdbId } });
        if (!oldMeta) return res.status(404).json({ message: `No metadata found for IMDb ID: ${currentImdbId}` });
        const threads = await models.Thread.findAll({ where: { tmdb_id: oldMeta.tmdb_id } });
        if (threads.length === 0) {
            return res.status(404).json({ message: `No threads linked to IMDb ID ${currentImdbId}.` });
        }
        const newData = await metadata.getTmdbMetadataById(correctId);
        if (!newData || !newData.dbEntry) {
            return res.status(400).json({ message: `Could not resolve new ID: ${correctId}` });
        }
        await models.TmdbMetadata.upsert(newData.dbEntry);
        const newTmdbId = newData.dbEntry.tmdb_id;
        const threadIds = threads.map(t => t.id);
        await models.Thread.update({ tmdb_id: newTmdbId }, { where: { id: threadIds } });
        const [streamUpdateCount] = await models.Stream.update({ tmdb_id: newTmdbId }, {
            where: { tmdb_id: oldMeta.tmdb_id }
        });
        await updateDashboardCache();
        res.json({
            message: `Re-linked ${threads.length} thread(s) and ${streamUpdateCount} stream(s) to TMDB ${newTmdbId}.`
        });
    } catch (error) {
        logger.error(error, 'correct-link failed.');
        res.status(500).json({ message: 'Internal error during correction.' });
    }
});

// Health snapshot for UI
router.get('/health', async (req, res) => {
    try {
        const cache = getDashboardCache();
        const dbPath = path.join('/data', 'stremio_addon.db');
        let dbSizeBytes = null;
        try {
            const stat = fs.statSync(dbPath);
            dbSizeBytes = stat.size;
        } catch (_) { }
        const trackerCount = require('../services/tracker').getTrackers().length;
        const provider = debrid.getProvider ? debrid.getProvider() : null;
        const hasInstantCheck = provider && typeof provider.checkCached === 'function';

        res.json({
            lastUpdated: cache.lastUpdated,
            linked: cache.linked,
            pending: cache.pending,
            failed: cache.failed,
            isCrawling,
            debridService: config.debridService,
            debridEnabled: config.debridService !== 'none',
            debridCacheCheck: hasInstantCheck ? 'instant' : 'database',
            realDebridEnabled: !!config.realDebridApiKey,
            torboxEnabled: !!config.torboxApiKey,
            tmdbConfigured: !!config.tmdbApiKey,
            trackerCount,
            dbSizeBytes,
            cacheAges: {
                dashboardMs: cache.lastUpdated ? (Date.now() - new Date(cache.lastUpdated).getTime()) : null
            }
        });
    } catch (error) {
        logger.error(error, 'health failed');
        res.status(500).json({ message: 'Health endpoint failed' });
    }
});

// Recent activity combined
router.get('/recent', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '15', 10), 50);
    try {
        const recentLinked = await models.Thread.findAll({
            where: { status: 'linked' },
            order: [['updatedAt', 'DESC']],
            limit
        });
        const recentFailures = await models.FailedThread.findAll({
            order: [['last_attempt', 'DESC']],
            limit
        });
        res.json({
            linked: recentLinked.map(t => ({
                id: t.id, title: t.clean_title, type: t.type,
                postedAt: t.postedAt, updatedAt: t.updatedAt
            })),
            failures: recentFailures.map(f => ({
                thread_hash: f.thread_hash, title: f.raw_title,
                reason: f.reason, last_attempt: f.last_attempt
            })),
            corrections: []
        });
    } catch (error) {
        logger.error(error, 'recent failed');
        res.status(500).json({ message: 'Error fetching recent activity.' });
    }
});

// Retry a failed parse
router.post('/retry-parse', async (req, res) => {
    const { threadHash } = req.body || {};
    if (!threadHash) return res.status(400).json({ message: 'threadHash is required.' });
    try {
        const failure = await models.FailedThread.findByPk(threadHash);
        if (!failure) return res.status(404).json({ message: 'Failed thread not found.' });
        await models.FailedThread.destroy({ where: { thread_hash: threadHash } });
        res.json({ message: `Retry scheduled: removed failure for "${failure.raw_title}".` });
    } catch (error) {
        logger.error(error, 'retry-parse failed');
        res.status(500).json({ message: 'Error scheduling retry.' });
    }
});

// Manually cache magnets for a pending thread in Debrid with duplicate lock
router.post('/rd-cache-pending', async (req, res) => {
    if (!debrid.isEnabled) return res.status(400).json({ message: 'Debrid service is not enabled.' });
    const { threadId, infohash } = req.body || {};
    if (!threadId) return res.status(400).json({ message: 'threadId is required.' });
    try {
        const thread = await models.Thread.findByPk(threadId);
        if (!thread || thread.status !== 'pending_tmdb' || !Array.isArray(thread.magnet_uris) || thread.magnet_uris.length === 0) {
            return res.status(404).json({ message: 'Pending thread with magnets not found.' });
        }
        const parsed = [];
        for (const magnet of thread.magnet_uris) {
            const p = parser.parseMagnet(magnet, thread.type);
            if (p) parsed.push({ ...p, magnet });
        }
        const targets = infohash ? parsed.filter(p => p.infohash === infohash) : parsed;
        if (targets.length === 0) return res.status(404).json({ message: 'No matching streams to cache.' });

        let lockedCount = 0;
        let newlyAdded = 0;

        for (const item of targets) {
            const existingLock = await models.DebridCacheLock.findByPk(item.infohash);
            if (existingLock) {
                logger.info({ infohash: item.infohash }, 'Debrid cache already initiated (local lock).');
                continue;
            }

            let torrentId = null;
            try {
                const addResp = await debrid.addMagnet(item.magnet);
                torrentId = addResp?.id || null;
            } catch (e) {
                logger.warn({ infohash: item.infohash, err: e?.message }, 'Debrid addMagnet probe returned error.');
            }

            if (torrentId) {
                try {
                    const info = await debrid.getTorrentInfo(torrentId);
                    await models.DebridTorrent.upsert({
                        infohash: item.infohash,
                        torrent_id: torrentId,
                        provider: config.debridService,
                        status: info?.status || 'unknown',
                        files: info?.files || null,
                        links: info?.links || null,
                        last_checked: new Date()
                    });
                    await models.DebridCacheLock.upsert({ infohash: item.infohash, createdAt: new Date() });
                    lockedCount++;
                    try { await debrid.selectFiles(torrentId, 'all'); newlyAdded++; } catch (_) { }
                    continue;
                } catch (e) {
                    logger.warn({ infohash: item.infohash, torrentId, err: e?.message }, 'Failed to fetch debrid torrent info.');
                }
            }

            const resp = await debrid.addAndSelect(item.magnet);
            if (resp && resp.id) {
                await models.DebridTorrent.upsert({
                    infohash: item.infohash,
                    torrent_id: resp.id,
                    provider: config.debridService,
                    status: resp?.status || 'unknown',
                    files: resp?.files || null,
                    links: resp?.links || null,
                    last_checked: new Date()
                });
                await models.DebridCacheLock.upsert({ infohash: item.infohash, createdAt: new Date() });
                lockedCount++;
                newlyAdded++;
            }
        }

        res.json({
            message: `Debrid caching ensured for ${lockedCount}/${targets.length} stream(s). Newly added: ${newlyAdded}.`
        });
    } catch (error) {
        logger.error(error, 'rd-cache-pending failed');
        res.status(500).json({ message: 'Error triggering debrid cache.' });
    }
});

// Check if a torrent exists on debrid by infohash (pure local check)
router.post('/rd-check', async (req, res) => {
    if (!debrid.isEnabled) return res.status(400).json({ message: 'Debrid service is not enabled.' });
    const { infohash } = req.body || {};
    if (!infohash) return res.status(400).json({ message: 'infohash is required.' });
    try {
        const lockedLocal = await models.DebridCacheLock.findByPk(infohash);
        if (lockedLocal) {
            return res.json({ found: true, updatedLocal: false });
        }
        const debridTorrent = await models.DebridTorrent.findByPk(infohash);
        if (debridTorrent && debridTorrent.status === 'downloaded') {
            await models.DebridCacheLock.upsert({ infohash, createdAt: new Date() });
            return res.json({ found: true, updatedLocal: true });
        }
        return res.json({ found: false, updatedLocal: false });
    } catch (error) {
        logger.error(error, 'rd-check failed');
        res.status(500).json({ message: 'Error checking debrid.', error: error?.message });
    }
});

module.exports = router;
