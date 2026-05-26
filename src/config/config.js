// src/config/config.js
require('dotenv').config();

const config = {
    port: process.env.PORT || 3000,
    logLevel: process.env.LOG_LEVEL || 'info',

    // Scraper Configuration
    seriesForumUrls: (process.env.SERIES_FORUM_URLS || process.env.FORUM_URLS || process.env.FORUM_URL || '')
        .split(',').map(url => url.trim()).filter(url => url),
    movieForumUrls: (process.env.MOVIE_FORUM_URLS || '')
        .split(',').map(url => url.trim()).filter(url => url),
    dubbedMovieForumUrls: (process.env.DUBBED_MOVIE_FORUM_URLS || '')
        .split(',').map(url => url.trim()).filter(url => url),
    scrapeStartPage: parseInt(process.env.SCRAPE_START_PAGE, 10) || 1,
    scrapeEndPage: parseInt(process.env.SCRAPE_END_PAGE, 10) || 20,
    scraperConcurrency: parseInt(process.env.SCRAPER_CONCURRENCY, 10) || 5,
    scraperRetryCount: parseInt(process.env.SCRAPER_RETRY_COUNT, 10) || 3,
    scraperTimeoutSecs: parseInt(process.env.SCRAPER_TIMEOUT_SECS, 10) || 30,
    scraperUserAgent: process.env.SCRAPER_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

    // Scheduler Configuration
    mainWorkflowCron: process.env.MAIN_WORKFLOW_CRON || '0 */6 * * *',

    // TMDB API Key
    tmdbApiKey: process.env.TMDB_API_KEY,

    // ─── Debrid Provider Configuration ───────────────────────────
    debridService: (process.env.DEBRID_SERVICE || '').toLowerCase() || null,

    // Real-Debrid
    realDebridApiKey: process.env.REALDEBRID_API_KEY || null,

    // TorBox
    torboxApiKey: process.env.TORBOX_API_KEY || null,

    // Proxy Configuration
    proxyUrls: process.env.PROXY_URLS
        ? process.env.PROXY_URLS.split(',').map(url => url.trim())
        : [],

    // Stremio Manifest
    addonId: 'org.stremio.torrent.nodejs.example',
    addonName: 'Tamil Webseries',
    addonDescription: 'A Stremio addon providing webseries streams.',
    addonVersion: '1.0.0',
    placeholderPoster: 'https://upload.wikimedia.org/wikipedia/en/thumb/d/da/Aha_%28streaming_service.svg/250px-Aha_%28streaming_service.svg.png',

    trackerUrl: process.env.TRACKER_URL || "https://ngosang.github.io/trackerslist/trackers_best.txt",
    appHost: process.env.APP_HOST || 'http://127.0.0.1:3000',

    forumSortQuery: (process.env.FORUM_SORT_QUERY || '').trim(),

    // Database Maintenance
    dbAutoVacuumCron: process.env.DB_AUTO_VACUUM_CRON || null,
    dbAutoVacuumEnabled: process.env.DB_AUTO_VACUUM_ENABLED === 'true' || false,
};

// ─── Boolean Flags ───────────────────────────────────────────────
config.isRdEnabled = !!config.realDebridApiKey;
config.isTorboxEnabled = !!config.torboxApiKey;
config.isProxyEnabled = config.proxyUrls.length > 0;

// Auto-detect debrid service if not explicitly set
if (!config.debridService) {
    if (config.isRdEnabled) config.debridService = 'realdebrid';
    else if (config.isTorboxEnabled) config.debridService = 'torbox';
    else config.debridService = 'none';
}

// Validate that the chosen service has an API key
if (config.debridService !== 'none') {
    const key = config.debridService === 'torbox' ? config.torboxApiKey : config.realDebridApiKey;
    if (!key) {
        console.warn(`DEBRID_SERVICE is '${config.debridService}' but no API key is set. Debrid will be disabled.`);
        config.debridService = 'none';
    }
}

// Validate required variables
const hasAnyForumUrl = config.seriesForumUrls.length > 0 || config.movieForumUrls.length > 0 || config.dubbedMovieForumUrls.length > 0;
if (!hasAnyForumUrl) {
    console.warn('WARNING: No forum URLs configured. The addon will start but won\'t scrape anything.');
}

module.exports = config;
