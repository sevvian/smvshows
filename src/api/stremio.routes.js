const express = require('express');
const router = express.Router();
const config = require('../config/config');
const { models, sequelize } = require('../database/connection');
const debrid = require('../services/debrid');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const parser = require('../services/parser');
const ptt = require('parse-torrent-title');
const { getTrackers } = require('../services/tracker');

const qualityOrder = { '4K': 1, '2160p': 1, '1080p': 2, '720p': 3, '480p': 4, 'SD': 5 };

function sortStreams(a, b) {
    if (a.isRD && !b.isRD) return -1;
    if (!a.isRD && b.isRD) return 1;
    const qa = qualityOrder[a.quality] || 99;
    const qb = qualityOrder[b.quality] || 99;
    if (qa !== qb) return qa - qb;
    const la = (a.language || 'zz').toLowerCase();
    const lb = (b.language || 'zz').toLowerCase();
    return la.localeCompare(lb);
}

function buildSeriesTitle({ season, episode, episode_end, quality, language }) {
    const seasonStr = String(season).padStart(2, '0');
    let epPart = '';
    if (!episode_end || episode_end === episode)
        epPart = `Episode ${String(episode).padStart(2, '0')}`;
    else if (episode === 1 && episode_end === 999)
        epPart = 'Season Pack';
    else
        epPart = `Episodes ${String(episode).padStart(2, '0')}-${String(episode_end).padStart(2, '0')}`;
    const langPart = language ? ` | ${language}` : '';
    return `S${seasonStr} | ${epPart}${langPart}\n${quality || 'SD'}`;
}

function buildMovieTitle({ tmdbTitle, quality, language }) {
    const langPart = language ? ` | ${language}` : '';
    return `${tmdbTitle}${langPart}\n${quality || 'SD'}`;
}

function buildTrackerSources() {
    const trackers = getTrackers();
    const allowed = [];
    for (const t of trackers) {
        if (t.startsWith('udp://') || t.startsWith('http://') || t.startsWith('https://')) {
            const proto = t.startsWith('udp://') ? 'udp' : 'http';
            const rest = t.replace(/^udp:\/\//, '').replace(/^https?:\/\//, '');
            allowed.push(`tracker:${proto}://${rest}`);
        }
    }
    return allowed;
}

function withDhtSource(sources, infohash) {
    const list = Array.isArray(sources) ? sources.slice() : [];
    if (infohash) list.push(`dht:${infohash}`);
    return list;
}

function dedupeStreams(streams) {
    const seen = new Set();
    const out = [];
    for (const s of streams) {
        const key = `${s.isRD ? 'rd' : 'p2p'}|${s.quality || 'SD'}|${(s.language || 'NA').toLowerCase()}|${s.infoHash || s.url || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
    }
    return out;
}

// ── Manifest ─────────────────────────────────────────────────────
router.get('/manifest.json', (req, res) => {
    const manifest = {
        id: config.addonId,
        version: "12.0.0",
        name: config.addonName,
        description: config.addonDescription,
        resources: ['catalog', 'meta', 'stream'],
        types: ['series', 'movie'],
        catalogs: [
    {
        type: 'series',
        id: 'tamilmv_series',
        name: 'Tamil WebSeries',
        extra: [{ name: 'skip', isRequired: false }]
    },
    {
        type: 'movie',
        id: 'tamilmv_hd_movies',
        name: 'Tamil HD Movies',
        extra: [{ name: 'skip', isRequired: false }]
    },
    {
        type: 'movie',
        id: 'tamilmv_dubbed_movies',
        name: 'Tamil HD Dubbed Movies',
        extra: [{ name: 'skip', isRequired: false }]
    }
],
        idPrefixes: ['tt']
    };
    res.json(manifest);
});

// ── Catalog (v3.0.1‑fixed: hybrid skip support, pending items) ──
// ── Catalog (v3.0.1‑fixed: hybrid skip + 3 separate catalogs) ──
router.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    const { type, id } = req.params;

    // Support both path‑based skip (/skip=N.json) and query‑string (?skip=N)
    let skip = parseInt(req.query.skip || '0', 10);
    if (req.params.extra && req.params.extra.startsWith('skip=')) {
        skip = parseInt(req.params.extra.split('=')[1] || '0', 10);
    }

    const limit = 100;

    // Map catalog id → Thread.catalog value used by the scraper
    const catalogMap = {
        tamilmv_series: 'series',
        tamilmv_hd_movies: 'movies',
        tamilmv_dubbed_movies: 'dubbed_movies'
    };

    const catalogValue = catalogMap[id];
    if (!catalogValue) {
        return res.status(404).json({ err: 'Catalog not found' });
    }

    // Validate type consistency
    if (id === 'tamilmv_series' && type !== 'series') {
        return res.status(404).json({ err: 'Catalog not found' });
    }
    if ((id === 'tamilmv_hd_movies' || id === 'tamilmv_dubbed_movies') && type !== 'movie') {
        return res.status(404).json({ err: 'Catalog not found' });
    }

    try {
        const whereClause = {
            type,
            status: 'linked',
            catalog: catalogValue       // ← filters by the catalog assigned during scraping
        };

        const allThreads = await models.Thread.findAll({
            where: whereClause,
            include: [{
                model: models.TmdbMetadata,
                required: false        // LEFT JOIN – keeps threads without metadata
            }],
            order: [['postedAt', 'DESC']],
            offset: skip,
            limit
        });

        const metas = allThreads.map(thread => {
            if (thread.status === 'linked' && thread.TmdbMetadatum && thread.TmdbMetadatum.imdb_id) {
                const meta = thread.TmdbMetadatum;
                const data = (typeof meta.data === 'string') ? JSON.parse(meta.data) : meta.data;
                return {
                    id: meta.imdb_id,
                    type: thread.type,
                    name: data.title,
                    poster: data.poster_path
                        ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
                        : config.placeholderPoster,
                    description: data.overview || '',
                    releaseInfo: String(data.release_date || '').substring(0, 4),
                    imdbRating: data.vote_average ? String(data.vote_average) : null,
                    genres: (data.genres || []).map(g => (typeof g === 'string' ? g : g.name)),
                };
            }
            return null;
        }).filter(Boolean);

        res.json({ metas });
    } catch (error) {
        logger.error(error, `Failed to fetch catalog for type: ${type}, id: ${id}`);
        res.status(500).json({ err: 'Internal Server Error' });
    }
});

// ── Meta ─────────────────────────────────────────────────────────
router.get('/meta/:type/:id.json', async (req, res) => {
    const { id } = req.params;

    try {
        const meta = await models.TmdbMetadata.findOne({ where: { imdb_id: id } });
        if (!meta) return res.status(404).json({ meta: {} });

        const data = (typeof meta.data === 'string') ? JSON.parse(meta.data) : meta.data;
        res.json({
            meta: {
                id: meta.imdb_id,
                type: data.type || 'series',
                name: data.title,
                poster: data.poster_path
                    ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
                    : config.placeholderPoster,
                description: data.overview || '',
                releaseInfo: String(data.release_date || '').substring(0, 4),
                imdbRating: data.vote_average ? String(data.vote_average) : null,
                genres: (data.genres || []).map(g => (typeof g === 'string' ? g : g.name)),
            }
        });
    } catch (error) {
        logger.error(error, `Failed to fetch meta for ID: ${id}`);
        res.status(500).json({ meta: {} });
    }
});

// ── Helpers ──────────────────────────────────────────────────────
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function isNonTerminal(status) {
    return ['waiting_files_selection', 'queued', 'downloading', 'magnet_conversion', 'compressing', 'uploading']
        .includes((status || '').toLowerCase());
}

function redirectTo(res, url) {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, url);
}

function isVideo(path) {
    const p = path.toLowerCase();
    return p.endsWith('.mkv') || p.endsWith('.mp4') || p.endsWith('.avi') || p.endsWith('.mov') || p.endsWith('.m4v');
}

function pickLargestVideo(files) {
    const videos = (files || []).filter(f => isVideo(f.path || ''));
    if (videos.length === 0) return null;
    return videos.reduce((largest, cur) => (cur.bytes > (largest?.bytes || 0) ? cur : largest), null);
}

function tryMatchEpisode(files, episode) {
    if (!Array.isArray(files)) return null;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!isVideo(f.path || '')) continue;
        const p = ptt.parse(f.path);
        let ep = p.episode;
        if (ep === undefined) {
            const re = /S(\d{1,2})\s*(?:E|EP|\s)\s*(\d{1,3})/i;
            const m = f.path.match(re);
            if (m) ep = parseInt(m[2], 10);
        }
        if (ep === parseInt(episode, 10)) {
            return { file: f, index: i };
        }
    }
    return null;
}

async function pickAndUnrestrict(info, requestedEpisode) {
    if (!Array.isArray(info.files) || !Array.isArray(info.links)) return null;
    let fileToStream = null;
    let linkIndex = -1;
    if (requestedEpisode && requestedEpisode > 0) {
        const match = tryMatchEpisode(info.files, requestedEpisode);
        if (match) {
            fileToStream = match.file;
            linkIndex = match.index;
        }
    }
    if (!fileToStream) {
        const largest = pickLargestVideo(info.files);
        if (largest) {
            fileToStream = largest;
            const idx = info.files.findIndex(f => f.id === largest.id);
            linkIndex = idx !== -1 ? idx : 0;
        }
    }
    if (fileToStream && linkIndex >= 0 && info.links[linkIndex]) {
        try {
            const unrestricted = await debrid.unrestrictLink(info.links[linkIndex]);
            return unrestricted?.download || null;
        } catch (e) {
            logger.warn({ err: e?.message }, 'unrestrictLink failed.');
            return null;
        }
    }
    return null;
}

async function upsertDebridSnapshot(infohash, torrentId, info) {
    await models.DebridTorrent.upsert({
        infohash,
        torrent_id: torrentId,
        provider: config.debridService,
        status: info?.status || 'unknown',
        files: info?.files || null,
        links: info?.links || null,
        last_checked: new Date()
    });
    if (models.DebridCacheLock) {
        await models.DebridCacheLock.upsert({ infohash, createdAt: new Date() });
    }
}

async function safeGetTorrentInfo(torrentId) {
    try {
        return await debrid.getTorrentInfo(torrentId);
    } catch (e) {
        return null;
    }
}

// ── Debrid on-demand: single-flight add/select/poll with re-add on 404 ──
router.get('/rd-add/:infohash/:episode.json', async (req, res) => {
    if (!debrid.isEnabled) {
        return res.status(400).json({ message: 'Debrid service is not enabled.' });
    }
    const infohash = String(req.params.infohash || '').toLowerCase();
    const requestedEpisode = parseInt(req.params.episode || '1', 10);

    try {
        // Fast path: local cached debrid snapshot with links/files
        let cached = await models.DebridTorrent.findByPk(infohash);
        if (cached && Array.isArray(cached.files) && Array.isArray(cached.links) && cached.links.length > 0) {
            const link = await pickAndUnrestrict(cached, requestedEpisode);
            if (link) return redirectTo(res, link);
        }

        // Ensure this infohash is indexed
        const streamRow = await models.Stream.findOne({ where: { infohash } });
        if (!streamRow) {
            logger.warn({ infohash }, 'No Stream record for infohash (not indexed).');
            return res.status(503).json({ message: 'Stream not indexed yet. Retry shortly.' });
        }

        // Fetch magnet from MagnetCache (authoritative)
        const magnetRow = await models.MagnetCache.findByPk(infohash);
        if (!magnetRow || !magnetRow.magnet) {
            logger.warn({ infohash }, 'Magnet missing in MagnetCache for linked item.');
            return res.status(503).json({ message: 'Magnet unavailable. Retry later.' });
        }
        const magnet = magnetRow.magnet;

        // Determine torrentId/add necessity respecting single-flight lock and local status
        let torrentId = cached?.torrent_id || null;
        let lock = await models.DebridCacheLock.findByPk(infohash);

        if (cached && isNonTerminal(cached.status)) {
            if (!lock) await models.DebridCacheLock.upsert({ infohash, createdAt: new Date() });
        } else if (!lock) {
            await models.DebridCacheLock.upsert({ infohash, createdAt: new Date() });
            let torrentAddedViaMagnet = false;

            if (!torrentId) {
                try {
                    const addResp = await debrid.addMagnet(magnet);
                    torrentId = addResp?.id || null;
                    if (torrentId) {
                        await models.DebridTorrent.upsert({
                            infohash,
                            torrent_id: torrentId,
                            provider: config.debridService,
                            status: 'queued',
                            last_checked: new Date()
                        });
                        torrentAddedViaMagnet = true;
                    }
                } catch (e) {
                    logger.warn({ infohash, err: e?.message }, 'Debrid addMagnet failed; trying addAndSelect as fallback.');
                }
            }

            if (!torrentId) {
                const resp = await debrid.addAndSelect(magnet);
                if (resp && resp.id) {
                    torrentId = resp.id;
                    await upsertDebridSnapshot(infohash, torrentId, resp);
                }
            }

            if (torrentAddedViaMagnet && torrentId) {
                await delay(3000);
                try { await debrid.selectFiles(torrentId, 'all'); } catch (_) { }
            }
        }

        if (!torrentId) {
            const freshCache = await models.DebridTorrent.findByPk(infohash);
            torrentId = freshCache?.torrent_id || null;
        }

        if (!torrentId) {
            return res.status(503).json({ message: 'Debrid torrent not created yet. Retry shortly.' });
        }

        // Poll up to 3 minutes with 3s interval; re-add once on 404
        const deadline = Date.now() + 3 * 60 * 1000;
        let readded = false;

        while (Date.now() < deadline) {
            await delay(3000);
            let info = null;
            try {
                info = await debrid.getTorrentInfo(torrentId);
            } catch (e) {
                const is404 = e && e.name === 'ResourceNotFoundError';
                if (is404 && !readded) {
                    logger.warn({ infohash, torrent_id: torrentId }, 'Debrid 404 detected during poll; re-adding once.');
                    let newId = null;
                    try { const addResp = await debrid.addMagnet(magnet); newId = addResp?.id || null; } catch (_) { }
                    if (!newId) {
                        const resp = await debrid.addAndSelect(magnet);
                        if (resp && resp.id) {
                            newId = resp.id;
                            await upsertDebridSnapshot(infohash, newId, resp);
                        }
                    }
                    if (newId) {
                        torrentId = newId;
                        await delay(3000);
                        try { await debrid.selectFiles(torrentId, 'all'); } catch (_) { }
                        readded = true;
                        continue;
                    }
                }
                continue;
            }

            await upsertDebridSnapshot(infohash, torrentId, info);

            if (Array.isArray(info.files) && Array.isArray(info.links) && info.links.length > 0
                && (info.status || '').toLowerCase() === 'downloaded') {
                const link = await pickAndUnrestrict(info, requestedEpisode);
                if (link) return redirectTo(res, link);
            }
        }

        return res.status(503).json({ message: 'Debrid still preparing this stream. Please retry shortly.' });
    } catch (error) {
        logger.error(error, 'rd-add failed unexpectedly');
        return res.status(503).json({ message: 'Temporary debrid error. Retry shortly.' });
    }
});

// ── Stream endpoint ──────────────────────────────────────────────
router.get('/stream/:type/:id.json', async (req, res) => {
    const { type } = req.params;
    if (type !== 'series' && type !== 'movie') {
        return res.status(404).json({ streams: [] });
    }
    const requestedId = req.params.id;
    let finalStreams = [];
    const trackerSources = buildTrackerSources();

    try {
        let imdb_id, season, episode;

        if (requestedId.startsWith(config.addonId)) {
            const parts = requestedId.split(':');
            const itemTypeOrImdb = parts[1];

            if (itemTypeOrImdb === 'pending') {
                const threadId = parts[2];
                const thread = await models.Thread.findByPk(threadId);
                if (thread && thread.status === 'pending_tmdb' && thread.magnet_uris) {
                    for (const magnet_uri of thread.magnet_uris) {
                        const parsed = parser.parseMagnet(magnet_uri, thread.type);
                        if (!parsed) continue;
                        if (thread.type === 'movie') {
                            finalStreams.push({
                                infoHash: parsed.infohash,
                                name: `[P2P] ${parsed.quality || 'SD'} `,
                                title: `${thread.clean_title}${parsed.language ? ' | ' + parsed.language : ''}\n${parsed.quality || 'SD'}`,
                                quality: parsed.quality,
                                language: parsed.language,
                                isRD: false,
                                sources: withDhtSource(trackerSources, parsed.infohash)
                            });
                        } else {
                            let epStr;
                            if (parsed.type === 'SEASON_PACK') epStr = 'Season Pack';
                            else if (parsed.type === 'EPISODE_PACK')
                                epStr = `Episodes ${String(parsed.episodeStart).padStart(2, '0')}-${String(parsed.episodeEnd).padStart(2, '0')}`;
                            else epStr = `Episode ${String(parsed.episode).padStart(2, '0')}`;
                            finalStreams.push({
                                infoHash: parsed.infohash,
                                name: `[P2P] ${parsed.quality || 'SD'} `,
                                title: `S${String(parsed.season).padStart(2, '0')} | ${epStr}${parsed.language ? ' | ' + parsed.language : ''}\n${parsed.quality || 'SD'}`,
                                quality: parsed.quality,
                                language: parsed.language,
                                isRD: false,
                                sources: withDhtSource(trackerSources, parsed.infohash)
                            });
                        }
                    }
                }
            } else if (itemTypeOrImdb.startsWith('tt')) {
                imdb_id = itemTypeOrImdb;
                if (type === 'series') {
                    if (parts.length < 4) return res.json({ streams: [] });
                    season = parts[2];
                    episode = parts[3];
                }
            }
        } else if (requestedId.startsWith('tt')) {
            const parts = requestedId.split(':');
            imdb_id = parts[0];
            if (type === 'series') {
                if (parts.length < 3) return res.json({ streams: [] });
                season = parts[1];
                episode = parts[2];
            }
        }

        if (imdb_id) {
            const meta = await models.TmdbMetadata.findOne({ where: { imdb_id } });
            if (!meta) return res.json({ streams: [] });

            const whereClause = { tmdb_id: meta.tmdb_id };
            if (type === 'series' && season && episode) {
                whereClause.season = season;
                whereClause.episode = { [Op.lte]: episode };
                whereClause.episode_end = { [Op.gte]: episode };
            } else if (type === 'movie') {
                whereClause.season = null;
                whereClause.episode = null;
            }

            const dbStreams = await models.Stream.findAll({ where: whereClause });

            // ── BATCH CACHE CHECK (v3.0) ──────────────────────────
            let cacheStatus = {};
            if (debrid.isEnabled && dbStreams.length > 0) {
                const allHashes = [...new Set(dbStreams.map(s => s.infohash))];
                cacheStatus = await debrid.checkCached(allHashes, models);
            }

            if (debrid.isEnabled) {
                for (const stream of dbStreams) {
                    let titleDetail = '';
                    if (type === 'series') {
                        titleDetail = buildSeriesTitle({
                            season: stream.season,
                            episode: stream.episode,
                            episode_end: stream.episode_end,
                            quality: stream.quality,
                            language: stream.language
                        });
                    } else {
                        const data = (typeof meta.data === 'string') ? JSON.parse(meta.data) : meta.data;
                        titleDetail = buildMovieTitle({
                            tmdbTitle: data.title,
                            quality: stream.quality,
                            language: stream.language
                        });
                    }

                    const isCached = cacheStatus[stream.infohash] === true;

                    const debridTorrent = await models.DebridTorrent.findByPk(stream.infohash);

                    if (debridTorrent && debridTorrent.status === 'downloaded' && debridTorrent.files && debridTorrent.links) {
                        let fileToStream;
                        let linkIndex = -1;
                        const downloadableFiles = debridTorrent.files.filter(file => file.selected === 1);

                        if (type === 'movie') {
                            const videoFiles = downloadableFiles.filter(file =>
                                ['.mkv', '.mp4', '.avi'].some(ext => file.path.toLowerCase().endsWith(ext))
                            );
                            if (videoFiles.length > 0) {
                                fileToStream = videoFiles.reduce((largest, current) =>
                                    current.bytes > largest.bytes ? current : largest, videoFiles[0]);
                                linkIndex = downloadableFiles.findIndex(f => f.id === fileToStream.id);
                            }
                        } else {
                            for (let i = 0; i < downloadableFiles.length; i++) {
                                const file = downloadableFiles[i];
                                let foundEpisode;
                                const p = ptt.parse(file.path);
                                foundEpisode = p.episode;
                                if (foundEpisode === undefined) {
                                    const regex = /S(\d{1,2})\s*(?:E|EP|\s)\s*(\d{1,3})/i;
                                    const match = file.path.match(regex);
                                    if (match) foundEpisode = parseInt(match[2], 10);
                                }
                                if (foundEpisode === parseInt(episode)) {
                                    fileToStream = file;
                                    linkIndex = i;
                                    break;
                                }
                            }
                        }

                        if (fileToStream && linkIndex !== -1 && debridTorrent.links[linkIndex]) {
                            const unrestricted = await debrid.unrestrictLink(debridTorrent.links[linkIndex]);
                            finalStreams.push({
                                name: `[RD+] ${stream.quality || 'SD'} ⚡️`,
                                url: unrestricted.download,
                                title: `${titleDetail}\n${fileToStream.path.substring(1)}`,
                                quality: stream.quality,
                                language: stream.language,
                                isRD: true
                            });
                        } else {
                            finalStreams.push({
                                name: isCached ? `[RD+] ${stream.quality || 'SD'} ⚡` : `[RD] ${stream.quality || 'SD'} ⏳`,
                                url: `${config.appHost}/rd-add/${stream.infohash}/${episode || 1}.json`,
                                title: `${titleDetail}\nFile not found`,
                                quality: stream.quality,
                                language: stream.language,
                                isRD: true
                            });
                        }
                    } else {
                        finalStreams.push({
                            name: isCached ? `[RD+] ${stream.quality || 'SD'} ⚡` : `[RD] ${stream.quality || 'SD'} ⏳`,
                            url: `${config.appHost}/rd-add/${stream.infohash}/${episode || 1}.json`,
                            title: `${titleDetail}\nClick to Download`,
                            quality: stream.quality,
                            language: stream.language,
                            isRD: true
                        });
                    }
                }
            } else {
                // P2P only
                const data = (typeof meta.data === 'string') ? JSON.parse(meta.data) : meta.data;
                if (type === 'movie') {
                    for (const s of dbStreams) {
                        finalStreams.push({
                            infoHash: s.infohash,
                            name: `[P2P] ${s.quality || 'SD'} `,
                            title: buildMovieTitle({ tmdbTitle: data.title, quality: s.quality, language: s.language }),
                            quality: s.quality,
                            language: s.language,
                            isRD: false,
                            sources: withDhtSource(trackerSources, s.infohash)
                        });
                    }
                } else {
                    for (const s of dbStreams) {
                        finalStreams.push({
                            infoHash: s.infohash,
                            name: `[P2P] ${s.quality || 'SD'} `,
                            title: buildSeriesTitle({
                                season: s.season,
                                episode: s.episode,
                                episode_end: s.episode_end,
                                quality: s.quality,
                                language: s.language
                            }),
                            quality: s.quality,
                            language: s.language,
                            isRD: false,
                            sources: withDhtSource(trackerSources, s.infohash)
                        });
                    }
                }
            }
        }

        finalStreams = dedupeStreams(finalStreams);
        finalStreams.sort(sortStreams);
        res.json({ streams: finalStreams });
    } catch (error) {
        logger.error(error, 'stream endpoint failed');
        res.json({ streams: [] });
    }
});

module.exports = router;
