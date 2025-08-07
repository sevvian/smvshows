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
const rd = require('../services/realdebrid');
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

// NEW: Parsed streams for a pending thread + lock info
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
            return `S${String(p.season).padStart(2,'0')} ${epStr} • ${p.quality || 'SD'}${p.language ? ' • ' + p.language : ''}`;
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
    const locks = await models.RdCacheLock.findAll({ where: { infohash: { [Op.in]: items.map(i => i.infohash) } }, raw: true });
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

// Update custom poster/description for a pending item
router.post('/update-pending', async (req, res) => {
  const { threadId, poster, description } = req.body || {};
  if (!threadId) return res.status(400).json({ message: 'threadId is required.' });
  try {
    const thread = await models.Thread.findByPk(threadId);
    if (!thread || thread.status !== 'pending_tmdb') {
      return res.status(404).json({ message: 'Pending thread not found.' });
    }
    thread.custom_poster = poster || null;
    thread.custom_description = description || null;
    await thread.save();
    res.json({ message: `Updated pending metadata for "${thread.clean_title}".` });
  } catch (error) {
    logger.error(error, 'update-pending failed.');
    res.status(500).json({ message: 'Internal error during update.' });
  }
});

// Link a pending item with a provided official id (IMDb or TMDB)
router.post('/link-official', async (req, res) => {
  const { threadId, manualId } = req.body || {};
  if (!threadId || !manualId) return res.status(400).json({ message: 'threadId and manualId are required.' });

  try {
    const thread = await models.Thread.findByPk(threadId);
    if (!thread || thread.status !== 'pending_tmdb') {
      return res.status(404).json({ message: 'Pending thread not found.' });
    }

    const tmdbData = await metadata.getTmdbMetadataById(manualId);
    if (!tmdbData || !tmdbData.dbEntry) {
      return res.status(400).json({ message: `Could not find a match for ID: ${manualId}` });
    }

    await models.TmdbMetadata.upsert(tmdbData.dbEntry);

    thread.tmdb_id = tmdbData.dbEntry.tmdb_id;
    thread.status = 'linked';

    const streamsToCreate = [];
    const magnetUris = thread.magnet_uris || [];

    for (const magnet_uri of magnetUris) {
      const parsed = parser.parseMagnet(magnet_uri, thread.type);
      if (!parsed) continue;

      if (thread.type === 'series') {
        const entry = {
          tmdb_id: tmdbData.dbEntry.tmdb_id,
          infohash: parsed.infohash,
          quality: parsed.quality,
          language: parsed.language,
          season: parsed.season || null,
          episode: null,
          episode_end: null,
        };
        if (parsed.type === 'SEASON_PACK') {
          entry.episode = 1;
          entry.episode_end = 999;
        } else if (parsed.type === 'EPISODE_PACK') {
          entry.episode = parsed.episodeStart;
          entry.episode_end = parsed.episodeEnd;
        } else if (parsed.type === 'SINGLE_EPISODE') {
          entry.episode = parsed.episode;
          entry.episode_end = parsed.episode;
        }
        if (entry.season && entry.episode != null) {
          streamsToCreate.push(entry);
        }
      } else if (thread.type === 'movie') {
        streamsToCreate.push({
          tmdb_id: tmdbData.dbEntry.tmdb_id,
          infohash: parsed.infohash,
          quality: parsed.quality,
          language: parsed.language,
          season: null,
          episode: null,
          episode_end: null,
        });
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

    res.json({ message: `Linked "${thread.clean_title}" and created ${streamsToCreate.length} stream(s).` });
  } catch (error) {
    logger.error(error, 'link-official failed.');
    res.status(500).json({ message: 'Internal error during link.' });
  }
});

// Correct a mislinked item (re-point from current IMDb to new IMDb/TMDB)
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
    const [streamUpdateCount] = await models.Stream.update({ tmdb_id: newTmdbId }, { where: { tmdb_id: oldMeta.tmdb_id } });

    await updateDashboardCache();

    res.json({ message: `Re-linked ${threads.length} thread(s) and ${streamUpdateCount} stream(s) to TMDB ${newTmdbId}.` });
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
    } catch (_) {}
    const trackerCount = require('../services/tracker').getTrackers().length;

    res.json({
      lastUpdated: cache.lastUpdated,
      linked: cache.linked,
      pending: cache.pending,
      failed: cache.failed,
      isCrawling,
      realDebridEnabled: !!config.realDebridApiKey,
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

// Recent activity combined (simple)
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
        id: t.id, title: t.clean_title, type: t.type, postedAt: t.postedAt, updatedAt: t.updatedAt
      })),
      failures: recentFailures.map(f => ({
        thread_hash: f.thread_hash, title: f.raw_title, reason: f.reason, last_attempt: f.last_attempt
      })),
      corrections: []
    });
  } catch (error) {
    logger.error(error, 'recent failed');
    res.status(500).json({ message: 'Error fetching recent activity' });
  }
});

// Paginated recent linked
router.get('/recent/linked', async (req, res) => {
  const page = Math.max(parseInt(req.query.page || '1', 10), 1);
  const limit = Math.min(parseInt(req.query.limit || '15', 10), 100);
  const offset = (page - 1) * limit;
  try {
    const { rows, count } = await models.Thread.findAndCountAll({
      where: { status: 'linked' },
      order: [['updatedAt', 'DESC']],
      limit,
      offset
    });
    res.json({
      page,
      limit,
      total: count,
      items: rows.map(t => ({
        id: t.id, title: t.clean_title, type: t.type, postedAt: t.postedAt, updatedAt: t.updatedAt
      }))
    });
  } catch (error) {
    logger.error(error, 'recent/linked failed');
    res.status(500).json({ message: 'Error fetching recent linked items' });
  }
});

// Retry a failed parse by removing failure record
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

// Enhanced: Manually cache magnets for a pending thread in Real-Debrid with duplicate lock
router.post('/rd-cache-pending', async (req, res) => {
  if (!rd.isEnabled) return res.status(400).json({ message: 'Real-Debrid is not enabled.' });
  const { threadId, infohash } = req.body || {};
  if (!threadId) return res.status(400).json({ message: 'threadId is required.' });

  try {
    const thread = await models.Thread.findByPk(threadId);
    if (!thread || thread.status !== 'pending_tmdb' || !Array.isArray(thread.magnet_uris) || thread.magnet_uris.length === 0) {
      return res.status(404).json({ message: 'Pending thread with magnets not found.' });
    }

    // Build parsed list, optionally filter by single infohash
    const parsed = [];
    for (const magnet of thread.magnet_uris) {
      const p = parser.parseMagnet(magnet, thread.type);
      if (p) parsed.push(p);
    }
    const targets = infohash ? parsed.filter(p => p.infohash === infohash) : parsed;

    if (targets.length === 0) return res.status(404).json({ message: 'No matching streams to cache.' });

    let success = 0;
    for (const item of targets) {
      // lock to prevent duplicates
      const existing = await models.RdCacheLock.findByPk(item.infohash);
      if (existing) {
        logger.info({ infohash: item.infohash }, 'RD cache already initiated; skipping duplicate.');
        continue;
      }
      // Upsert lock first
      await models.RdCacheLock.upsert({ infohash: item.infohash, createdAt: new Date() });
      const magnet = thread.magnet_uris.find(m => (m || '').toLowerCase().includes(item.infohash));
      const resp = await rd.addAndSelect(magnet || '');
      if (resp && resp.id) success++;
    }

    res.json({ message: `RD caching triggered for ${success}/${targets.length} selected stream(s).` });
  } catch (error) {
    logger.error(error, 'rd-cache-pending failed');
    res.status(500).json({ message: 'Error triggering RD cache.' });
  }
});

// NEW: Check if a torrent exists on RD by infohash and sync local DB/locks
router.post('/rd-check', async (req, res) => {
  if (!rd.isEnabled) return res.status(400).json({ message: 'Real-Debrid is not enabled.' });
  const { infohash, threadId } = req.body || {};
  if (!infohash) return res.status(400).json({ message: 'infohash is required.' });

  try {
    // If already locked locally, treat as found
    const lockedLocal = await models.RdCacheLock.findByPk(infohash);
    if (lockedLocal) {
      return res.json({ found: true, updatedLocal: false });
    }

    // Try to see if we have a downloaded torrent record
    const rdTorrent = await models.RdTorrent.findByPk(infohash);
    if (rdTorrent && rdTorrent.status === 'downloaded') {
      await models.RdCacheLock.upsert({ infohash, createdAt: new Date() });
      return res.json({ found: true, updatedLocal: true });
    }

    // As we don't have a direct RD search by hash in our service, we attempt a no-op flow:
    // If threadId is provided, ensure the magnet for that infohash exists in its magnet_uris
    if (!threadId) {
      return res.json({ found: false, updatedLocal: false });
    }
    const thread = await models.Thread.findByPk(threadId);
    if (!thread || !Array.isArray(thread.magnet_uris)) {
      return res.json({ found: false, updatedLocal: false });
    }
    const magnet = thread.magnet_uris.find(m => (m || '').toLowerCase().includes(infohash));
    if (!magnet) {
      return res.json({ found: false, updatedLocal: false });
    }

    // Try add & select; if RD says resource exists/selected, it will reflect on subsequent info calls.
    const added = await rd.addAndSelect(magnet);
    if (added && added.id) {
      await models.RdCacheLock.upsert({ infohash, createdAt: new Date() });
      // Try fetch info immediately and store a minimal snapshot
      try {
        const info = await rd.getTorrentInfo(added.id);
        await models.RdTorrent.upsert({
          infohash,
          rd_id: added.id,
          status: info?.status || 'unknown',
          files: info?.files || null,
          links: info?.links || null,
          last_checked: new Date(),
        });
      } catch (_) {}
      return res.json({ found: true, updatedLocal: true });
    }

    return res.json({ found: false, updatedLocal: false });
  } catch (error) {
    logger.error(error, 'rd-check failed');
    res.status(500).json({ message: 'Error checking RD.', error: error?.message });
  }
});

module.exports = router;