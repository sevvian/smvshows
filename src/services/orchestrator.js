const { runCrawler } = require('./crawler');
const parser = require('./parser');
const metadata = require('./metadata');
const crud = require('../database/crud');
const logger = require('../utils/logger');
const { models, sequelize } = require('../database/connection');

let isCrawling = false;
let dashboardCache = { linked: 0, pending: 0, failed: 0, lastUpdated: null };

async function updateDashboardCache() {
    try {
        logger.info('Updating dashboard cache...');
        const linked = await models.Thread.count({ where: { status: 'linked' } });
        const pending = await models.Thread.count({ where: { status: 'pending_tmdb' } });
        const failed = await models.FailedThread.count();
        dashboardCache = { linked, pending, failed, lastUpdated: new Date() };
        logger.info({ cache: dashboardCache }, 'Dashboard cache updated successfully.');
    } catch (error) {
        logger.error(error, 'Failed to update dashboard cache.');
    }
}

function getDashboardCache() { return dashboardCache; }

const runFullWorkflow = async () => {
    if (isCrawling) {
        logger.warn("Crawl is already in progress. Skipping this trigger.");
        return;
    }
    
    isCrawling = true;
    logger.info("🚀 Starting full crawling and processing workflow...");
    
    try {
        const allScrapedThreads = await runCrawler();
        
        let processedCount = 0;
        let skippedCount = 0;

        for (const threadData of allScrapedThreads) {
            const { thread_hash, raw_title, magnet_uris, type, postedAt, catalogId } = threadData;

            const existingThread = await models.Thread.findOne({ where: { raw_title } });

            if (existingThread) {
                if (existingThread.thread_hash === thread_hash) {
                    skippedCount++;
                    continue;
                } else {
                    logger.info(`Thread content has changed. Re-processing: ${raw_title}`);
                    await existingThread.destroy();
                }
            }
            
            processedCount++;
            logger.info({ title: raw_title, type }, `Processing new or updated thread.`);

            const parsedTitle = parser.parseTitle(raw_title);
            if (!parsedTitle) {
                await crud.logFailedThread(thread_hash, raw_title, 'Title parsing failed critically.');
                continue;
            }

            const tmdbData = await metadata.getTmdbMetadata(parsedTitle.clean_title, parsedTitle.year, type);
            
            const t = await sequelize.transaction();
            try {
                if (tmdbData && tmdbData.dbEntry) {
                    const { dbEntry } = tmdbData;
                    await models.TmdbMetadata.upsert(dbEntry, { transaction: t });
                    await crud.createOrUpdateThread({
                        thread_hash, raw_title, clean_title: parsedTitle.clean_title, 
                        year: parsedTitle.year, tmdb_id: dbEntry.tmdb_id, 
                        status: 'linked', magnet_uris: null,
                        type, postedAt, catalog: catalogId
                    }, { transaction: t });

                    const streamsToCreate = [];
                    const magnetPairs = []; // {infohash, magnet}
                    for (const magnet_uri of magnet_uris) {
                        const streamDetails = parser.parseMagnet(magnet_uri, type); 
                        if (streamDetails) {
                            // cache magnet for linked items
                            magnetPairs.push({ infohash: streamDetails.infohash, magnet: magnet_uri });

                            let streamEntry = {
                                tmdb_id: dbEntry.tmdb_id,
                                infohash: streamDetails.infohash,
                                quality: streamDetails.quality,
                                language: streamDetails.language
                            };
                            if (type === 'series' && streamDetails.season) {
                                streamEntry.season = streamDetails.season;
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
                                streamsToCreate.push(streamEntry);
                            } else if (type === 'movie') {
                                streamEntry.season = null;
                                streamEntry.episode = null;
                                streamsToCreate.push(streamEntry);
                            }
                        }
                    }
                    if (streamsToCreate.length > 0) {
                        await models.Stream.bulkCreate(streamsToCreate, { ignoreDuplicates: true, transaction: t });
                        logger.info(`Upserted ${streamsToCreate.length} stream entries for ${parsedTitle.clean_title}`);
                    }
                    if (magnetPairs.length > 0) {
                        for (const mp of magnetPairs) {
                            await models.MagnetCache.upsert({ infohash: mp.infohash.toLowerCase(), magnet: mp.magnet, createdAt: new Date() }, { transaction: t });
                        }
                    }
                } else {
                    logger.warn(`No TMDB match for "${parsedTitle.clean_title}". Saving as 'pending_tmdb'.`);
                    await crud.createOrUpdateThread({
                        thread_hash, raw_title, clean_title: parsedTitle.clean_title,
                        year: parsedTitle.year, tmdb_id: null,
                        status: 'pending_tmdb', magnet_uris: magnet_uris,
                        type, postedAt, catalog: catalogId
                    }, { transaction: t });
                }

                await t.commit();

            } catch (error) {
                await t.rollback();
                logger.error(error, `Transaction failed for thread "${raw_title}". Rolling back changes.`);
                await crud.logFailedThread(thread_hash, raw_title, 'DB transaction failed.');
            }
        }
        logger.info({
            totalScraped: allScrapedThreads.length,
            newOrUpdated: processedCount,
            unchangedSkipped: skippedCount
        }, 'Processing complete.');
    } catch (error) {
        logger.error(error, "The crawling workflow encountered a fatal error.");
    } finally {
        isCrawling = false;
        await updateDashboardCache();
        logger.info("✅ Workflow finished.");
    }
};

module.exports = { runFullWorkflow, isCrawling, updateDashboardCache, getDashboardCache };