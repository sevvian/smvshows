const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/config');

const tmdbApi = axios.create({
    baseURL: 'https://api.themoviedb.org/3',
    params: { api_key: config.tmdbApiKey },
    timeout: 8000
});

// ---------- helpers (pure, local) ----------
function normalizeTitle(s) {
    if (!s) return '';
    return String(s)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // strip diacritics
        .replace(/[^a-z0-9\s]/g, ' ') // keep alnum + spaces
        .replace(/\s+/g, ' ')
        .trim();
}

function parseYear(dateStr) {
    if (!dateStr || typeof dateStr !== 'string' || dateStr.length < 4) return null;
    const y = parseInt(dateStr.substring(0, 4), 10);
    return Number.isNaN(y) ? null : y;
}

function withinToleranceMovie(parsedYear, resultYear) {
    if (!parsedYear || !resultYear) return false;
    return Math.abs(parsedYear - resultYear) <= 1;
}

function withinToleranceTv(parsedYear, firstAirYear) {
    if (!parsedYear || !firstAirYear) return false;
    return Math.abs(parsedYear - firstAirYear) <= 2;
}

function baseTitleFromResult(result, type) {
    return type === 'movie' ? (result.title || result.original_title) : (result.name || result.original_name);
}

function yearFromResult(result, type) {
    return type === 'movie' ? parseYear(result.release_date) : parseYear(result.first_air_date);
}

async function fetchAlternativeTitles(resultId, type) {
    const media_type = type === 'movie' ? 'movie' : 'tv';
    try {
        const resp = await tmdbApi.get(`/${media_type}/${resultId}/alternative_titles`);
        // movie returns { titles: [{ title }] }, tv returns { results: [{ title }] }
        if (media_type === 'movie') {
            return Array.isArray(resp.data?.titles) ? resp.data.titles.map(t => t.title).filter(Boolean) : [];
        } else {
            const arr = Array.isArray(resp.data?.results) ? resp.data.results : [];
            return arr.map(t => t.title).filter(Boolean);
        }
    } catch (e) {
        logger.debug({ id: resultId, type }, 'Alt titles fetch skipped/failed.');
        return [];
    }
}

function scoreCandidate({ result, type, queryTitleN, parsedYear, regionBias }) {
    const titlesToCompare = [];
    const main = baseTitleFromResult(result, type);
    const orig = type === 'movie' ? result.original_title : result.original_name;

    if (main) titlesToCompare.push(main);
    if (orig && orig !== main) titlesToCompare.push(orig);

    const titlesN = titlesToCompare.map(normalizeTitle);
    const mainN = titlesN[0] || '';
    const year = yearFromResult(result, type);

    let score = 0;
    let reasons = [];

    // Exact title match (normalized)
    if (titlesN.includes(queryTitleN)) {
        score += 6;
        reasons.push('exact_title');
    } else {
        // prefix/contains proximity
        if (mainN.startsWith(queryTitleN) || queryTitleN.startsWith(mainN)) {
            score += 3;
            reasons.push('prefix_close');
        } else if (mainN.includes(queryTitleN) || queryTitleN.includes(mainN)) {
            score += 2;
            reasons.push('contains');
        }
    }

    // Year tolerance
    if (type === 'movie') {
        if (parsedYear && year && parsedYear === year) { score += 4; reasons.push('year_exact'); }
        else if (withinToleranceMovie(parsedYear, year)) { score += 2; reasons.push('year_tol'); }
    } else {
        if (parsedYear && year && parsedYear === year) { score += 3; reasons.push('tv_year_exact'); }
        else if (withinToleranceTv(parsedYear, year)) { score += 2; reasons.push('tv_year_tol'); }
    }

    // Region bias hint (non-deterministic)
    if (regionBias && result.origin_country && Array.isArray(result.origin_country)) {
        if (result.origin_country.includes('IN')) { score += 1; reasons.push('region_hint'); }
    }

    // Popularity/vote sanity as mild tiebreaker
    const pop = Number(result.popularity || 0);
    const vAvg = Number(result.vote_average || 0);
    const vCnt = Number(result.vote_count || 0);
    score += Math.min(Math.floor(pop / 25), 2); // cap
    if (vAvg >= 6 && vCnt >= 50) score += 1;

    return { score, year, reasons };
}

async function enrichScoreWithAliases(result, type, queryTitleN, currentScore) {
    // If already exact match, skip network call
    if (currentScore.reasons.includes('exact_title')) return currentScore;

    const alts = await fetchAlternativeTitles(result.id, type);
    if (alts.length === 0) return currentScore;

    const altN = alts.map(normalizeTitle);
    if (altN.includes(queryTitleN)) {
        currentScore.score += 4;
        currentScore.reasons.push('alt_exact');
    }
    return currentScore;
}

async function pickBestCandidate(type, queryTitle, parsedYear, regionBias, lists) {
    const queryTitleN = normalizeTitle(queryTitle);
    const candidates = [];

    for (const list of lists) {
        const results = Array.isArray(list) ? list : [];
        // Consider top 10 to keep it fast
        for (const result of results.slice(0, 10)) {
            const base = scoreCandidate({ result, type, queryTitleN, parsedYear, regionBias });
            const withAlts = await enrichScoreWithAliases(result, type, queryTitleN, base);
            candidates.push({ result, score: withAlts.score, reasons: withAlts.reasons });
        }
    }

    if (candidates.length === 0) return null;

    // Sort by score desc, then by vote_count, then by popularity
    candidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const avc = Number(a.result.vote_count || 0), bvc = Number(b.result.vote_count || 0);
        if (bvc !== avc) return bvc - avc;
        const ap = Number(a.result.popularity || 0), bp = Number(b.result.popularity || 0);
        return bp - ap;
    });

    const best = candidates[0];

    // Confidence gating: require a modest threshold to auto-link
    // Movies: >=8, TV: >=7 (TV is trickier with first_air_year variance)
    const threshold = type === 'movie' ? 8 : 7;
    if (best.score >= threshold) {
        logger.info({ title: queryTitle, bestId: best.result.id, score: best.score, reasons: best.reasons }, 'TMDB match accepted');
        return best.result;
    }

    logger.warn({ title: queryTitle, topScore: best.score, reasons: best.reasons }, 'TMDB match below confidence threshold; deferring to manual.');
    return null;
}

// --- Improved: multi-pass, scored, type-aware search ---
const getTmdbMetadata = async (title, year, type) => {
    const endpoint = type === 'movie' ? '/search/movie' : '/search/tv';
    logger.debug({ title, year, type, endpoint }, 'TMDB search (scored matcher)');

    // Build three passes: primary (title+year), region bias (title only, region IN), global (title only)
    const requests = [];

    // Primary with year
    requests.push(
        tmdbApi.get(endpoint, {
            params: type === 'movie'
                ? { query: title, year }
                : { query: title, first_air_date_year: year }
        }).then(r => r.data?.results || []).catch(e => {
            logger.debug({ err: e?.message }, 'TMDB primary failed'); return [];
        })
    );

    // Region bias (title only, IN)
    requests.push(
        tmdbApi.get(endpoint, { params: { query: title, region: 'IN' } })
            .then(r => r.data?.results || [])
            .catch(e => { logger.debug({ err: e?.message }, 'TMDB region pass failed'); return []; })
    );

    // Global (title only)
    requests.push(
        tmdbApi.get(endpoint, { params: { query: title } })
            .then(r => r.data?.results || [])
            .catch(e => { logger.debug({ err: e?.message }, 'TMDB global pass failed'); return []; })
    );

    const [primary, regionOnly, globalOnly] = await Promise.all(requests);

    // Pick best across all passes, scoring with year tolerance and aliases
    const best = await pickBestCandidate(type, title, year || null, true, [primary, regionOnly, globalOnly]);
    if (!best) {
        logger.error(`No confident TMDB match for "${title}" after all passes.`);
        return null;
    }

    return await formatTmdbData(best, type);
};

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
            logger.debug(`Looking up by TMDB ID: ${tmdbType}:${tmdbId}`);
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
        logger.warn({ err: error.message }, `Could not fetch episode data for TMDB ID ${tmdbId}, Season ${seasonNumber}`);
    }
    return [];
};

const formatTmdbData = async (tmdbResult, type) => {
    let imdb_id = null;
    const media_type = type === 'series' ? 'tv' : 'movie';

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
            tmdb_id: String(tmdbResult.id),
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