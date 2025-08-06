// src/services/parser.js
const ptt = require('parse-torrent-title');
const logger = require('../utils/logger');

// Regex patterns are now specifically for series parsing.
const SERIES_PARSING_PATTERNS = [
    { regex: /S(\d{1,2})\s*EP?\s*\((\d{1,3})[-\u2011](\d{1,3})\)/i, type: 'EPISODE_PACK' },
    { regex: /S(\d{1,2})\s?E(\d{1,3})[-‑]E?(\d{1,3})/i, type: 'EPISODE_PACK' },
    { regex: /S(\d{1,2})EP(\d{1,3})[-‑](\d{1,3})/i, type: 'EPISODE_PACK' },
    { regex: /S(\d{1,2})\s?EP?\(?(\d{1,3})\)?(?![-‑])/i, type: 'SINGLE_EPISODE' },
    { regex: /(?:S(eason)?\s*)(\d{1,2})(?!\s?E|\s?\d)|(Complete\sSeason|Season\s\d{1,2})/i, type: 'SEASON_PACK' }
];

function expandEpisodeRange(rangeStr) {
    const match = rangeStr.match(/(\d{1,3})[–-]\s*(\d{1,3})/);
    if (!match) return [];
    
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    const episodes = [];

    if (!isNaN(start) && !isNaN(end) && end >= start) {
        for (let i = start; i <= end; i++) {
            episodes.push(i);
        }
    }
    return episodes;
}

function parseTitle(rawTitle) {
    const cleanedForPtt = rawTitle.replace(/By\s[\w\s.-]+,.*$/i, '').trim();
    const pttResult = ptt.parse(cleanedForPtt);

    if (pttResult.title && pttResult.year) {
        return { clean_title: pttResult.title, year: pttResult.year };
    }

    logger.warn(`PTT failed to find both title and year for "${rawTitle}". Attempting heuristic fallback.`);
    
    let cleanTitle = cleanedForPtt;
    
    const yearMatch = cleanTitle.match(/[\[\(](\d{4})[\]\)]/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
    if (yearMatch) {
        cleanTitle = cleanTitle.replace(yearMatch[0], ' ');
    }

    const noisePatterns = [
        /\[.*?\]/g,
        /\(.*?Complete Series.*?\)/gi,
        /\b(1080p|720p|480p|2160p|4K|HD|HQ)\b/gi,
        /\b(WEB-DL|HDRip|BluRay|WEBrip|HDTV|UNTOUCHED|TRUE)\b/gi,
        /\b(x264|x265|HEVC|AVC)\b/gi,
        /\b(AAC|DDP5\.1|ATMOS|AC3)\b/gi,
        /\b(\d+(\.\d+)?(GB|MB))\b/gi,
        /\b(Esub|MSubs|Multi-Subs)\b/gi,
        /\b(Tam|Tel|Hin|Eng|Tamil|Telugu|Hindi|English|Kannada|Malayalam|Mal)\b/gi,
        /\b(Part|Vol|DAY)\s?\(?\d+.*\)?/gi,
        /S\d{1,2}(\s?E\d{1,3})?(\s?-\s?E\d{1,3})?/gi,
        /\(\s?E\d{1,2}\s?-\s?\d{1,2}\s?\)/gi,
        /EP\s?\(?\d+-\d+\)?/gi
    ];

    for (const pattern of noisePatterns) {
        cleanTitle = cleanTitle.replace(pattern, ' ');
    }
    
    cleanTitle = cleanTitle
        .replace(/[-–_.]/g, ' ')
        .replace(/[\[\](){}&:,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (cleanTitle) {
        logger.info(`Heuristic fallback succeeded for "${rawTitle}". Parsed Title: "${cleanTitle}", Year: ${year}`);
        return { clean_title: cleanTitle, year: year };
    }
    
    logger.error(`Critical parsing failure for title: "${rawTitle}". Both PTT and fallback failed.`);
    return null;
}

/**
 * Parses a magnet URI's 'dn' parameter to extract stream metadata.
 * Now handles both 'movie' and 'series' types.
 * @param {string} magnetUri The full magnet URI.
 * @param {string} type The type of content ('movie' or 'series').
 * @returns {object|null} An object with stream metadata.
 */
function parseMagnet(magnetUri, type = 'series') {
    try {
        const infohash = getInfohash(magnetUri);
        const params = new URLSearchParams(magnetUri.split('?')[1]);
        let filename = params.get('dn') || '';
        if (!infohash || !filename) return null;

        filename = decodeURIComponent(filename).replace(/^www\.\w+\.\w+\s*-\s*/, '').trim();
        const pttResult = ptt.parse(filename);

        if (type === 'movie') {
            return {
                type: 'MOVIE',
                infohash,
                quality: pttResult.resolution,
                language: pttResult.language
            };
        }

        if (type === 'series') {
            for (const pattern of SERIES_PARSING_PATTERNS) {
                const match = filename.match(pattern.regex);
                if (match) {
                    if (pattern.type === 'SEASON_PACK') {
                        const season = parseInt(match[1] || match[2]?.match(/\d+/)[0] || pttResult.season);
                        if (season) return { type: 'SEASON_PACK', infohash, season, quality: pttResult.resolution, language: pttResult.language };
                    } else if (pattern.type === 'SINGLE_EPISODE') {
                        const season = parseInt(match[1]);
                        const episode = parseInt(match[2]);
                        if (season && episode) return { type: 'SINGLE_EPISODE', infohash, season, episode, quality: pttResult.resolution, language: pttResult.language };
                    } else if (pattern.type === 'EPISODE_PACK') {
                        const season = parseInt(match[1]);
                        const episodeStart = parseInt(match[2]);
                        const episodeEnd = parseInt(match[3]);
                        if (season && episodeStart && episodeEnd) return { type: 'EPISODE_PACK', infohash, season, episodeStart, episodeEnd, quality: pttResult.resolution, language: pttResult.language };
                    }
                }
            }
            
            if (pttResult.season && pttResult.episode) {
                return { type: 'SINGLE_EPISODE', infohash, season: pttResult.season, episode: pttResult.episode, quality: pttResult.resolution, language: pttResult.language };
            }
            if (pttResult.season) {
                return { type: 'SEASON_PACK', infohash, season: pttResult.season, quality: pttResult.resolution, language: pttResult.language };
            }
        }

        logger.warn({ filename, type }, 'All parsing patterns failed for magnet dn.');
        return null;

    } catch (e) {
        logger.error({ err: e, magnet: magnetUri.substring(0, 70) }, `Magnet parsing failed`);
        return null;
    }
}

function getInfohash(magnetUri) {
    if (!magnetUri) return null;
    const match = magnetUri.match(/btih:([a-fA-F0-9]{40})/);
    return match ? match[1].toLowerCase() : null;
}

module.exports = { 
    parseTitle, 
    parseMagnet,
    getInfohash
};
