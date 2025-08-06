const express = require('express');
const router = express.Router();
const config = require('../config/config');
const { models, sequelize } = require('../database/connection');
const rd = require('../services/realdebrid');
const { Op } = require('sequelize');
const logger = require('../utils/logger');
const parser = require('../services/parser');
const ptt = require('parse-torrent-title');

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
  if (!episode_end || episode_end === episode) epPart = `Episode ${String(episode).padStart(2, '0')}`;
  else if (episode === 1 && episode_end === 999) epPart = 'Season Pack';
  else epPart = `Episodes ${String(episode).padStart(2, '0')}-${String(episode_end).padStart(2, '0')}`;
  const langPart = language ? ` | ${language}` : '';
  return `S${seasonStr} | ${epPart}${langPart}\n${quality || 'SD'}`;
}

function buildMovieTitle({ tmdbTitle, quality, language }) {
  const langPart = language ? ` | ${language}` : '';
  return `${tmdbTitle}${langPart}\n${quality || 'SD'}`;
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

router.get('/manifest.json', (req, res) => {
  const manifest = {
    id: config.addonId,
    version: "12.0.0",
    name: config.addonName,
    description: config.addonDescription,
    resources: ['catalog', 'stream', 'meta'],
    types: ['series', 'movie'],
    idPrefixes: [config.addonId, 'tt'],
    catalogs: [
      { type: 'series', id: 'top-series-from-forum', name: 'Tamil Webseries', extra: [{ name: 'skip', isRequired: false }] },
      { type: 'movie', id: 'tamil-hd-movies', name: 'Tamil HD Movies', extra: [{ name: 'skip', isRequired: false }] },
      { type: 'movie', id: 'tamil-dubbed-movies', name: 'Tamil HD Dubbed Movies', extra: [{ name: 'skip', isRequired: false }] }
    ],
    behaviorHints: { configurable: false, adult: false }
  };
  res.json(manifest);
});

router.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
  const { type, id } = req.params;
  let skip = 0;
  if (req.params.extra && req.params.extra.startsWith('skip=')) {
    skip = parseInt(req.params.extra.split('=')[1] || '0', 10);
  }

  if (type === 'series' && id === 'top-series-from-forum') {
    return getSeriesCatalog(req, res, skip);
  }
  if (type === 'movie' && (id === 'tamil-hd-movies' || id === 'tamil-dubbed-movies')) {
    return getMovieCatalog(req, res, skip, id);
  }

  return res.status(404).json({ err: 'Not Found' });
});

async function getSeriesCatalog(req, res, skip) {
  const limit = 100;
  try {
    const allThreads = await models.Thread.findAll({
      where: { type: 'series' },
      include: [{ model: models.TmdbMetadata, required: false }],
      order: [
        [sequelize.literal("CASE `Thread`.`status` WHEN 'linked' THEN 0 ELSE 1 END"), 'ASC'],
        ['postedAt', 'DESC']
      ],
      offset: skip,
      limit
    });
    const metas = allThreads.map(thread => {
      if (thread.status === 'linked' && thread.TmdbMetadatum && thread.TmdbMetadatum.imdb_id) {
        const meta = thread.TmdbMetadatum;
        const data = (typeof meta.data === 'string') ? JSON.parse(meta.data) : meta.data;
        return {
          id: meta.imdb_id,
          type: 'series',
          name: data.title,
          poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
        };
      } else if (thread.status === 'pending_tmdb') {
        return {
          id: `${config.addonId}:pending:${thread.id}`,
          type: 'series',
          name: `[PENDING] ${thread.clean_title}${thread.year ? ' (' + thread.year + ')' : ''}`,
          poster: thread.custom_poster || config.placeholderPoster,
          description: thread.custom_description || 'This item is pending an official metadata match.'
        };
      }
      return null;
    }).filter(Boolean);
    res.json({ metas });
  } catch (error) {
    logger.error(error, "Failed to fetch series catalog data.");
    res.status(500).json({ err: 'Internal Server Error' });
  }
}

async function getMovieCatalog(req, res, skip, catalogId) {
  const limit = 100;
  try {
    const allThreads = await models.Thread.findAll({
      where: { type: 'movie', catalog: catalogId, status: 'linked' },
      include: [{ model: models.TmdbMetadata, required: true }],
      order: [['postedAt', 'DESC']],
      offset: skip,
      limit
    });
    const metas = allThreads.map(thread => {
      const meta = thread.TmdbMetadatum;
      const data = (typeof meta.data === 'string') ? JSON.parse(meta.data) : meta.data;
      return {
        id: meta.imdb_id,
        type: 'movie',
        name: data.title,
        poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
      };
    });
    res.json({ metas });
  } catch (error) {
    logger.error(error, "Failed to fetch movie catalog data.");
    res.status(500).json({ err: 'Internal Server Error' });
  }
}

router.get('/meta/:type/:id.json', async (req, res) => {
  const { type, id } = req.params;
  if ((type !== 'series' && type !== 'movie') || !id.startsWith(config.addonId)) {
    return res.status(404).json({ err: 'Not Found' });
  }

  try {
    const parts = id.split(':');
    const itemType = parts[1];
    if (itemType === 'pending') {
      const threadId = parts[2];
      const thread = await models.Thread.findByPk(threadId);
      if (!thread || thread.status !== 'pending_tmdb') return res.status(404).json({ err: 'Pending item not found' });

      return res.json({
        meta: {
          id,
          type: thread.type,
          name: `[PENDING] ${thread.clean_title}${thread.year ? ' (' + thread.year + ')' : ''}`,
          poster: thread.custom_poster || config.placeholderPoster,
          description: thread.custom_description || 'Metadata is pending.',
          releaseInfo: thread.year ? String(thread.year) : ''
        }
      });
    }
    return res.status(404).json({ err: 'This addon only provides metadata for pending items.' });
  } catch (error) {
    logger.error(error, `Failed to fetch meta for ID: ${id}`);
    res.status(500).json({ err: 'Internal Server Error' });
  }
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

router.get('/rd-poll/:infohash/:episode.json', async (req, res) => {
  const { infohash, episode } = req.params;
  if (!rd.isEnabled || !infohash) return res.status(404).send('Not Found');
  try {
    const streamRecord = await models.Stream.findOne({ where: { infohash } });
    let mediaType = 'series';
    if (streamRecord && streamRecord.tmdb_id) {
      const metaRecord = await models.TmdbMetadata.findByPk(streamRecord.tmdb_id);
      if (metaRecord) {
        const data = (typeof metaRecord.data === 'string') ? JSON.parse(metaRecord.data) : metaRecord.data;
        mediaType = data.media_type === 'tv' ? 'series' : 'movie';
      }
    }

    const rdTorrent = await models.RdTorrent.findByPk(infohash);
    if (!rdTorrent || !rdTorrent.rd_id) {
      return res.status(404).json({ error: 'Torrent not being processed.' });
    }
    const pollTimeout = 180000;
    const pollInterval = 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < pollTimeout) {
      const torrentInfo = await rd.getTorrentInfo(rdTorrent.rd_id);
      if (torrentInfo && (torrentInfo.status === 'error' || torrentInfo.status === 'magnet_error')) {
        break;
      }
      if (torrentInfo && torrentInfo.status === 'waiting_files_selection') {
        await rd.selectFiles(torrentInfo.id);
      }
      if (torrentInfo && torrentInfo.status === 'downloaded') {
        await rdTorrent.update({ status: 'downloaded', files: torrentInfo.files, links: torrentInfo.links, last_checked: new Date() });

        let fileToStream;
        let linkIndex = -1;
        const downloadableFiles = torrentInfo.files.filter(file => file.selected === 1);

        if (mediaType === 'movie') {
          const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv'];
          const videoFiles = downloadableFiles.filter(file => videoExtensions.some(ext => file.path.toLowerCase().endsWith(ext)));
          if (videoFiles.length > 0) {
            fileToStream = videoFiles.reduce((largest, current) => current.bytes > largest.bytes ? current : largest, videoFiles[0]);
            linkIndex = downloadableFiles.findIndex(f => f.id === fileToStream.id);
          }
        } else {
          for (let i = 0; i < downloadableFiles.length; i++) {
            const file = downloadableFiles[i];
            const p = ptt.parse(file.path);
            let foundEpisode = p.episode;
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
          if (!fileToStream) {
            const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.wmv'];
            const videoFiles = downloadableFiles.filter(file => videoExtensions.some(ext => file.path.toLowerCase().endsWith(ext)));
            if (videoFiles.length === 1) {
              fileToStream = videoFiles[0];
              linkIndex = downloadableFiles.findIndex(f => f.id === fileToStream.id);
            }
          }
        }

        if (fileToStream && linkIndex !== -1 && torrentInfo.links[linkIndex]) {
          const unrestricted = await rd.unrestrictLink(torrentInfo.links[linkIndex]);
          return res.redirect(302, unrestricted.download);
        }
        break;
      }
      await delay(pollInterval);
    }
    await rdTorrent.update({ status: 'error' });
    res.status(404).json({ error: 'Torrent timed out or failed.' });
  } catch (error) {
    if (error instanceof rd.ResourceNotFoundError) {
      await models.RdTorrent.destroy({ where: { infohash } });
    }
    logger.error(error, `Polling failed for infohash: ${infohash}`);
    res.status(500).json({ error: 'Polling failed.' });
  }
});

router.head('/rd-add/:infohash/:episode.json', (req, res) => {
  res.status(200).end();
});

router.get('/rd-add/:infohash/:episode.json', async (req, res) => {
  const { infohash, episode } = req.params;
  if (!rd.isEnabled) return res.status(404).send('Not Found');

  const addAndProcess = async () => {
    const magnet = `magnet:?xt=urn:btih:${infohash}`;
    const rdResponse = await rd.addMagnet(magnet);
    if (rdResponse && rdResponse.id) {
      const rd_id = rdResponse.id;
      await models.RdTorrent.create({ infohash, rd_id, status: 'magnet_conversion' });

      let isReadyForSelection = false;
      const waitTimeout = 20000;
      const waitInterval = 2000;
      const start = Date.now();

      while (Date.now() - start < waitTimeout) {
        const torrentInfo = await rd.getTorrentInfo(rd_id);
        if (torrentInfo.status === 'waiting_files_selection') {
          isReadyForSelection = true;
          break;
        }
        if (torrentInfo.status === 'error' || torrentInfo.status === 'magnet_error') {
          throw new Error(`Real-Debrid failed to parse magnet: ${torrentInfo.status}`);
        }
        await delay(waitInterval);
      }

      if (!isReadyForSelection) throw new Error(`Torrent ${rd_id} was not ready for file selection in time.`);
      await rd.selectFiles(rd_id);
      return res.redirect(`/rd-poll/${infohash}/${episode}.json`);
    }
    throw new Error('Could not add torrent to Real-Debrid.');
  };

  try {
    const existing = await models.RdTorrent.findByPk(infohash);
    if (existing) {
      try {
        await rd.getTorrentInfo(existing.rd_id);
        return res.redirect(`/rd-poll/${infohash}/${episode}.json`);
      } catch (error) {
        if (error instanceof rd.ResourceNotFoundError) {
          await existing.destroy();
          return await addAndProcess();
        }
        throw error;
      }
    }
    await addAndProcess();
  } catch (error) {
    logger.error(error, `Critical failure during add process for infohash ${infohash}.`);
    res.status(500).json({ error: 'Could not process torrent on Real-Debrid.' });
  }
});

router.get('/stream/:type/:id.json', async (req, res) => {
  const { type } = req.params;
  if (type !== 'series' && type !== 'movie') {
    return res.status(404).json({ streams: [] });
  }

  const requestedId = req.params.id;
  let finalStreams = [];

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
                name: `[P2P] ${parsed.quality || 'SD'} 📺`,
                title: `${thread.clean_title}${parsed.language ? ' | ' + parsed.language : ''}\n${parsed.quality || 'SD'}`,
                quality: parsed.quality,
                language: parsed.language,
                isRD: false
              });
            } else {
              let epStr;
              if (parsed.type === 'SEASON_PACK') epStr = 'Season Pack';
              else if (parsed.type === 'EPISODE_PACK') epStr = `Episodes ${String(parsed.episodeStart).padStart(2, '0')}-${String(parsed.episodeEnd).padStart(2, '0')}`;
              else epStr = `Episode ${String(parsed.episode).padStart(2, '0')}`;
              finalStreams.push({
                infoHash: parsed.infohash,
                name: `[P2P] ${parsed.quality || 'SD'} 📺`,
                title: `S${String(parsed.season).padStart(2, '0')} | ${epStr}${parsed.language ? ' | ' + parsed.language : ''}\n${parsed.quality || 'SD'}`,
                quality: parsed.quality,
                language: parsed.language,
                isRD: false
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

      if (rd.isEnabled) {
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

          const rdTorrent = await models.RdTorrent.findByPk(stream.infohash);
          if (rdTorrent && rdTorrent.status === 'downloaded' && rdTorrent.files && rdTorrent.links) {
            let fileToStream;
            let linkIndex = -1;
            const downloadableFiles = rdTorrent.files.filter(file => file.selected === 1);

            if (type === 'movie') {
              const videoExtensions = ['.mkv', '.mp4', '.avi'];
              const videoFiles = downloadableFiles.filter(file => videoExtensions.some(ext => file.path.toLowerCase().endsWith(ext)));
              if (videoFiles.length > 0) {
                fileToStream = videoFiles.reduce((largest, current) => current.bytes > largest.bytes ? current : largest, videoFiles[0]);
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

            if (fileToStream && linkIndex !== -1 && rdTorrent.links[linkIndex]) {
              const unrestricted = await rd.unrestrictLink(rdTorrent.links[linkIndex]);
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
                name: `[RD] ${stream.quality || 'SD'} ⏳`,
                url: `${config.appHost}/rd-add/${stream.infohash}/${episode || 1}.json`,
                title: `${titleDetail}\nFile not found`,
                quality: stream.quality,
                language: stream.language,
                isRD: true
              });
            }
          } else {
            finalStreams.push({
              name: `[RD] ${stream.quality || 'SD'} ⏳`,
              url: `${config.appHost}/rd-add/${stream.infohash}/${episode || 1}.json`,
              title: `${titleDetail}\nClick to Download`,
              quality: stream.quality,
              language: stream.language,
              isRD: true
            });
          }
        }
      } else {
        const data = (typeof meta.data === 'string') ? JSON.parse(meta.data) : meta.data;
        if (type === 'movie') {
          for (const s of dbStreams) {
            finalStreams.push({
              infoHash: s.infohash,
              name: `[P2P] ${s.quality || 'SD'} 📺`,
              title: buildMovieTitle({ tmdbTitle: data.title, quality: s.quality, language: s.language }),
              quality: s.quality,
              language: s.language,
              isRD: false
            });
          }
        } else {
          for (const s of dbStreams) {
            finalStreams.push({
              infoHash: s.infohash,
              name: `[P2P] ${s.quality || 'SD'} 📺`,
              title: buildSeriesTitle({ season: s.season, episode: s.episode, episode_end: s.episode_end, quality: s.quality, language: s.language }),
              quality: s.quality,
              language: s.language,
              isRD: false
            });
          }
        }
      }
    }

    finalStreams = dedupeStreams(finalStreams).sort(sortStreams);
    res.json({ streams: finalStreams });
  } catch (error) {
    logger.error(error, 'Failed to build streams');
    res.status(500).json({ streams: [] });
  }
});

module.exports = router;