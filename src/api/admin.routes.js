const express = require('express');
const router = express.Router();
const { runFullWorkflow, getDashboardCache, updateDashboardCache } = require('../services/orchestrator'); 
const { models } = require('../database/connection');
const metadata = require('../services/metadata');
const parser = require('../services/parser');
const crud = require('../database/crud');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

router.post('/trigger-crawl', (req, res) => {
    runFullWorkflow();
    res.status(202).json({ message: "Crawl workflow triggered successfully. Check logs for progress." });
});

router.get('/dashboard', async (req, res) => {
    const cachedStats = getDashboardCache();
    if (!cachedStats.lastUpdated) {
        await updateDashboardCache();
        return res.json(getDashboardCache());
    }
    res.json(cachedStats);
});

router.get('/pending', async (req, res) => {
    try {
        const pendingThreads = await models.Thread.findAll({
            where: { status: 'pending_tmdb' },
            order: [['updatedAt', 'DESC']],
        });
        res.json(pendingThreads);
    } catch (error) {
        logger.error(error, "Failed to fetch pending threads.");
        res.status(500).json({ message: "Error fetching pending threads." });
    }
});

router.get('/failures', async (req, res) => {
    try {
        const failedThreads = await models.FailedThread.findAll({
            order: [['last_attempt', 'DESC']],
        });
        res.json(failedThreads);
    } catch (error) {
        logger.error(error, "Failed to fetch critical failures.");
        res.status(500).json({ message: "Error fetching critical failures." });
    }
});

router.post('/update-pending', async (req, res) => {
    const { threadId, poster, description } = req.body;
    if (!threadId) {
        return res.status(400).json({ message: 'threadId is required.' });
    }
    try {
        const thread = await models.Thread.findByPk(threadId);
        if (!thread || thread.status !== 'pending_tmdb') {
            return res.status(404).json({ message: 'Pending thread not found.' });
        }
        thread.custom_poster = poster || null;
        thread.custom_description = description || null;
        await thread.save();
        res.json({ message: `Successfully updated pending metadata for "${thread.clean_title}".` });
    } catch (error) {
        logger.error(error, 'Update pending operation failed.');
        res.status(500).json({ message: 'An internal error occurred during update.' });
    }
});

router.post('/link-official', async (req, res) => {
    const { threadId, manualId } = req.body;
    if (!threadId || !manualId) {
        return res.status(400).json({ message: 'threadId and manualId are required.' });
    }

    try {
        const thread = await models.Thread.findByPk(threadId);
        if (!thread || thread.status !== 'pending_tmdb') {
            return res.status(404).json({ message: 'Pending thread not found.' });
        }

        const tmdbData = await metadata.getTmdbMetadataById(manualId);
        if (!tmdbData) {
            return res.status(400).json({ message: `Could not find a match for ID: ${manualId}` });
        }
        
        await models.TmdbMetadata.upsert(tmdbData.dbEntry);
        
        thread.tmdb_id = tmdbData.dbEntry.tmdb_id;
        thread.status = 'linked';
        
        const streamsToCreate = [];
        const magnetUris = thread.magnet_uris || [];

        for (const magnet_uri of magnetUris) {
            const streamDetails = parser.parseMagnet(magnet_uri);
            if (streamDetails && streamDetails.season) {
                let streamEntry = {
                    tmdb_id: tmdbData.dbEntry.tmdb_id,
                    season: streamDetails.season,
                    infohash: streamDetails.infohash,
                    quality: streamDetails.quality,
                    language: streamDetails.language
                };
                if (streamDetails.type === 'SEASON_PACK') {
                    streamEntry.episode = 1;
                    streamEntry.episode_end = 999;
                } else if (streamDetails.type === 'EPISODE_PACK') {
                    streamEntry.episode = streamDetails.episodeStart;
                    streamEntry.episode_end = streamDetails.episodeEnd;
                } else if (streamDetails.type === 'SINGLE_EPISODE') {
                    streamEntry.episode = streamDetails.episode;
                    streamEntry.episode_end = streamDetails.episode;
                }
                if (streamEntry.episode) {
                    streamsToCreate.push(streamEntry);
                }
            }
        }
        
        if (streamsToCreate.length > 0) {
            await crud.createStreams(streamsToCreate);
        }
        
        thread.magnet_uris = null;
        thread.custom_poster = null;
        thread.custom_description = null;
        await thread.save();
        
        await updateDashboardCache();

        res.json({ message: `Successfully linked "${thread.clean_title}" and created ${streamsToCreate.length} streams.` });

    } catch (error) {
        logger.error(error, 'Rescue operation failed.');
        res.status(500).json({ message: 'An internal error occurred during rescue.' });
    }
});

// --- START OF FIX R10 ---
router.post('/correct-link', async (req, res) => {
    const { currentImdbId, correctId } = req.body;
    if (!currentImdbId || !correctId) {
        return res.status(400).json({ message: 'Both currentImdbId and correctId are required.' });
    }

    try {
        const oldMeta = await models.TmdbMetadata.findOne({ where: { imdb_id: currentImdbId } });
        if (!oldMeta) {
            return res.status(404).json({ message: `No linked item found for current IMDb ID: ${currentImdbId}` });
        }
        const oldTmdbId = oldMeta.tmdb_id;

        const threadsToUpdate = await models.Thread.findAll({ where: { tmdb_id: oldTmdbId } });
        if (threadsToUpdate.length === 0) {
            return res.status(404).json({ message: `Found metadata for ${currentImdbId}, but no threads are linked to it.` });
        }

        const newTmdbData = await metadata.getTmdbMetadataById(correctId);
        if (!newTmdbData || !newTmdbData.dbEntry) {
            return res.status(400).json({ message: `Could not find a valid TMDB entry for the correct ID: ${correctId}` });
        }
        await models.TmdbMetadata.upsert(newTmdbData.dbEntry);
        const newTmdbId = newTmdbData.dbEntry.tmdb_id;

        const threadIds = threadsToUpdate.map(t => t.id);
        await models.Thread.update(
            { tmdb_id: newTmdbId },
            { where: { id: threadIds } }
        );
        
        const [streamUpdateCount] = await models.Stream.update(
            { tmdb_id: newTmdbId },
            { where: { tmdb_id: oldTmdbId } }
        );

        await updateDashboardCache();

        const threadTitles = threadsToUpdate.map(t => t.clean_title).join(', ');
        res.json({ message: `Successfully re-linked ${threadsToUpdate.length} thread(s) (${threadTitles}) and ${streamUpdateCount} associated streams to new ID ${newTmdbId}.` });

    } catch (error) {
        logger.error(error, 'Correction operation failed.');
        res.status(500).json({ message: 'An internal error occurred during the correction process.' });
    }
});
// --- END OF FIX R10 ---

// --- NEW: HEALTH ENDPOINT ---
router.get('/health', async (req, res) => {
    try {
        const cache = getDashboardCache();
        const dbPath = path.join('/data', 'stremio_addon.db');
        let dbSizeBytes = null;
        try {
            const stat = fs.statSync(dbPath);
            dbSizeBytes = stat.size;
        } catch (e) {
            // ignore if not found
        }

        const trackerCount = require('../services/tracker').getTrackers().length;

        res.json({
            lastUpdated: cache.lastUpdated,
            linked: cache.linked,
            pending: cache.pending,
            failed: cache.failed,
            isCrawling: require('../services/orchestrator').isCrawling,
            realDebridEnabled: !!config.realDebridApiKey,
            tmdbConfigured: !!config.tmdbApiKey,
            trackerCount,
            dbSizeBytes
        });
    } catch (error) {
        logger.error(error, 'Failed to produce health summary');
        res.status(500).json({ message: 'Health endpoint failed' });
    }
});

// --- NEW: RECENT ACTIVITY ENDPOINT ---
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
        // Placeholder for corrections: could be logged into a new table in future
        const corrections = []; 

        res.json({
            linked: recentLinked.map(t => ({
                id: t.id, title: t.clean_title, type: t.type, postedAt: t.postedAt, updatedAt: t.updatedAt
            })),
            failures: recentFailures.map(f => ({
                thread_hash: f.thread_hash, title: f.raw_title, reason: f.reason, last_attempt: f.last_attempt
            })),
            corrections
        });
    } catch (error) {
        logger.error(error, 'Failed to fetch recent activity');
        res.status(500).json({ message: 'Error fetching recent activity' });
    }
});

module.exports = router;