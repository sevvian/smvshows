// src/services/metadata.js
const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/config');

const tmdbApi = axios.create({
    baseURL: 'https://api.themoviedb.org/3',
    params: { api_key: config.tmdbApiKey },
    timeout: 5000
});

// --- START OF FIX R13 ---
// The function now accepts a `type` ('movie' or 'series') to ensure it uses the correct TMDB endpoint.
const getTmdbMetadata = async (title, year, type) => {
    // Determine the correct, type-specific search endpoint.
    const endpoint = type === 'movie' ? '/search/movie' : '/search/tv';
    logger.debug({ title, year, type, endpoint }, 'Performing type-specific TMDB search.');

    // Step 1: Primary Search (Title + Year, Type-Specific)
    try {
        const response = await tmdbApi.get(endpoint, {
            params: { query: title, first_air_date_year: year, year: year },
        });

        if (response.data && response.data.results.length > 0) {
            const result = response.data.results[0];
            logger.info(`TMDB primary match found for "${title}": (Type: ${type}, ID: ${result.id})`);
            return await formatTmdbData(result, type);
        }
    } catch (error) {
        logger.error({ err: error.message }, `TMDB API error on primary search for "${title}"`);
    }

    // Step 2: Region-Specific Fallback (Title only, Region: IN, Type-Specific)
    logger.warn(`No TMDB match with year. Retrying with title only (Region: IN) for: "${title}"`);
    try {
        const response = await tmdbApi.get(endpoint, {
            params: { query: title, region: 'IN' },
        });

        if (response.data && response.data.results.length > 0) {
            const result = response.data.results[0];
            logger.info(`TMDB Indian-region match found for "${title}": (Type: ${type}, ID: ${result.id})`);
            return await formatTmdbData(result, type);
        }
    } catch (error) {
        logger.error({ err: error.message }, `TMDB API error on Indian-region search for "${title}"`);
    }

    // Step 3: Global Fallback (Title only, Type-Specific)
    logger.warn(`No Indian-region match. Retrying with title only (Global) for: "${title}"`);
    try {
        const response = await tmdbApi.get(endpoint, { params: { query: title } });
        if (response.data && response.data.results.length > 0) {
            const result = response.data.results[0];
            logger.info(`TMDB global fallback match found for "${title}": (Type: ${type}, ID: ${result.id})`);
            return await formatTmdbData(result, type);
        }
    } catch (error) {
        logger.error({ err: error.message }, `TMDB API error on global fallback search for "${title}"`);
    }

    logger.error(`No TMDB match found for "${title}" after all attempts.`);
    return null;
};
// --- END OF FIX R13 ---

const getTmdbMetadataById = async (id) => {
    try {
        let result;
        let type;
        if (id.startsWith('tt')) {
            logger.debug(`Looking up by IMDb ID: ${id}`);
            const findResponse = await tmdbApi.get(`/find/${id}`, { params: { external_source: 'imdb_id' } });
            result = findResponse.data.tv_results[0] || findResponse.data.movie_results[0];
            if (findResponse.data.tv_results[0]) type = 'series';
            if (findResponse.data.movie_results[0]) type = 'movie';
        } else if (id.includes(':')) {
            const [tmdbType, tmdbId] = id.split(':');
            logger.debug(`Looking up by TMDB ID: ${tmdbId} (Type: ${tmdbType})`);
            if (tmdbType !== 'tv' && tmdbType !== 'movie') {
                logger.error(`Invalid type in manual ID: ${tmdbType}`); return null;
            }
            type = tmdbType === 'tv' ? 'series' : 'movie';
            const findResponse = await tmdbApi.get(`/${tmdbType}/${tmdbId}`);
            result = findResponse.data;
        } else {
            logger.error(`Invalid manual ID format provided: ${id}. Must be 'tt...' or 'tv:...' or 'movie:...'.`);
            return null;
        }
        if (result) { return await formatTmdbData(result, type); }
    } catch (error) {
        logger.error({ err: error.message }, `TMDB API error during manual lookup for ID: ${id}`);
    }
    return null;
};


const getTmdbEpisodeData = async (tmdbId, seasonNumber) => {
    logger.debug(`Fetching episode data for TMDB ID ${tmdbId}, Season ${seasonNumber}`);
    try {
        const response = await tmdbApi.get(`/tv/${tmdbId}/season/${seasonNumber}`);
        if (response.data && response.data.episodes) {
            return response.data.episodes;
        }
    } catch (error) {
        // It's okay if a season isn't found, just log it and return empty.
        logger.warn({ err: error.message }, `Could not fetch episode data for TMDB ID ${tmdbId}, Season ${seasonNumber}`);
    }
    return [];
};


const formatTmdbData = async (tmdbResult, type) => {
    let imdb_id = null;
    // --- START OF FIX R13 ---
    // Use the provided `type` to determine the media_type, which is more reliable than guessing.
    const media_type = type === 'series' ? 'tv' : 'movie';
    // --- END OF FIX R13 ---

    try {
        const externalIdsResponse = await tmdbApi.get(`/${media_type}/${tmdbResult.id}/external_ids`);
        imdb_id = externalIdsResponse.data.imdb_id || null;
    } catch (e) {
        logger.warn(`Could not fetch external IDs for TMDB ID ${tmdbResult.id}.`);
    }

    const release_date = tmdbResult.release_date || tmdbResult.first_air_date;
    const year = release_date ? parseInt(release_date.substring(0, 4), 10) : null;

    return {
        dbEntry: {
            tmdb_id: tmdbResult.id.toString(),
            imdb_id: imdb_id,
            year: year,
            data: {
                media_type: media_type,
                title: tmdbResult.title || tmdbResult.name,
                poster_path: tmdbResult.poster_path,
                backdrop_path: tmdbResult.backdrop_path,
                overview: tmdbResult.overview,
            },
        }
    };
};

module.exports = { getTmdbMetadata, getTmdbMetadataById, getTmdbEpisodeData };
