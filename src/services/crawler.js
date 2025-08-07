const {
  CheerioCrawler,
  log,
  purgeDefaultStorages,
  Configuration,
} = require('crawlee');
const crypto = require('crypto');
const config = require('../config/config');
const logger = require('../utils/logger');
const fs = require('fs/promises');
const path = require('path');

/* ---------- helpers ---------- */
let proxyIndex = 0;

const generateThreadHash = (title, magnetUris) => {
  const magnetData = magnetUris.sort().join('');
  const data = title + magnetData;
  return crypto.createHash('sha256').update(data).digest('hex');
};

function appendQuery(urlStr, extraQuery) {
  if (!extraQuery) return urlStr;
  try {
    // Handle IPS-style routing where base contains "index.php?/"
    const isIpsStyle = urlStr.includes('index.php?/');
    // If classic query exists, always use &
    if (urlStr.includes('?') && !isIpsStyle) {
      return `${urlStr}&${extraQuery}`;
    }
    // If IPS-style, append with & even if there's no extra '?'
    if (isIpsStyle) {
      // Ensure trailing slash consistency before &
      const sep = urlStr.endsWith('/') ? '' : '/';
      return `${urlStr}${sep}&${extraQuery}`;
    }
    // Fallback: normal behavior – first param uses ?
    return `${urlStr}${urlStr.includes('?') ? '&' : '?'}${extraQuery}`;
  } catch (_) {
    return urlStr;
  }
}

/* ---------- crawler factory ---------- */
const createCrawler = (crawledData) =>
  new CheerioCrawler({
    useSessionPool: false,
    persistCookiesPerSession: false,

    navigationTimeoutSecs: config.scraperTimeoutSecs,
    maxConcurrency: config.scraperConcurrency,
    maxRequestRetries: config.scraperRetryCount,

    preNavigationHooks: [
      (crawlingContext, gotOptions) => {
        gotOptions.headers = {
          ...gotOptions.headers,
          'User-Agent': config.scraperUserAgent,
        };
        gotOptions.timeout = { request: config.scraperTimeoutSecs * 1000 };

        if (!config.isProxyEnabled) return;

        const originalUrl = crawlingContext.request.url;
        const proxyUrl =
          config.proxyUrls[proxyIndex % config.proxyUrls.length];
        proxyIndex++;

        log.debug('Transforming request for proxy.', {
          proxy: proxyUrl,
          target: originalUrl,
        });

        gotOptions.url = proxyUrl;
        gotOptions.method = 'POST';
        gotOptions.json = { pageURL: originalUrl };
      },
    ],

    async requestHandler({ request, $, crawler, response }) {
      if (!$ || typeof $.html !== 'function') {
        log.error(
          `Request for ${request.url} did not return valid HTML.`,
          { contentType: response?.headers['content-type'] }
        );
        return;
      }

      const { label } = request;
      switch (label) {
        case 'LIST':
          await handleListPage({ $, crawler, request });
          break;
        case 'DETAIL':
          await handleDetailPage({ $, request }, crawledData);
          break;
        default:
          log.error(
            `Unhandled request label '${label}' for URL: ${request.url}`
          );
      }
    },

    failedRequestHandler({ request }, error) {
      log.error(
        `Request ${request.url} failed and reached maximum retries.`,
        {
          url: request.url,
          retryCount: request.retryCount,
          error: error.message,
          statusCode: error.response?.statusCode,
          responseBodySnippet: error.response?.body
            ?.toString()
            .substring(0, 200),
        }
      );
    },
  });

/* ---------- page handlers ---------- */
async function handleListPage({ $, crawler, request }) {
  const { type, catalogId } = request.userData;
  const newRequests = [];
  const detailLinkSelector = 'h4.ipsDataItem_title > span.ipsType_break > a';

  $(detailLinkSelector).each((_, element) => {
    const linkEl = $(element);
    const threadContainer = linkEl.closest('.ipsDataItem');

    if (threadContainer.length) {
      const url = linkEl.attr('href');
      const raw_title = linkEl.text().trim();
      const timeEl = threadContainer.find('time[datetime]');
      const postedAt = timeEl.attr('datetime')
        ? new Date(timeEl.attr('datetime'))
        : null;

      if (url && raw_title) {
        newRequests.push({
          url,
          label: 'DETAIL',
          userData: { raw_title, type, postedAt, catalogId },
        });
      }
    }
  });

  if (newRequests.length) {
    log.info(
      `Enqueuing ${newRequests.length} detail pages of type '${type}' from catalog '${catalogId}'.`
    );
    await crawler.addRequests(newRequests);
  } else {
    log.warning(
      'No detail page links found on list page. The page structure might have changed.',
      { url: request.url }
    );
    // Save debug HTML only when logger level is debug
    const level = (logger && logger.level) ? logger.level : 'info';
    if (level === 'debug') {
      try {
        const debugDir = path.join('/data', 'debug');
        await fs.mkdir(debugDir, { recursive: true });
        const sanitizedUrl = request.url.replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `${new Date().toISOString()}_${sanitizedUrl}.html`;
        const filePath = path.join(debugDir, filename);
        await fs.writeFile(filePath, $.html());
        log.debug(`Saved HTML of failed page to: ${filePath}`);
      } catch (e) {
        log.debug('Failed to save debug HTML file.', { error: e.message });
      }
    }
  }
}

async function handleDetailPage({ $, request }, crawledData) {
  const {
    userData: { raw_title, type, postedAt, catalogId },
  } = request;

  const magnetSelector = 'a[href^="magnet:?"]';
  const magnet_uris = $(magnetSelector)
    .map((_, el) => $(el).attr('href'))
    .get();

  if (magnet_uris.length) {
    const thread_hash = generateThreadHash(raw_title, magnet_uris);
    crawledData.push({
      thread_hash,
      raw_title,
      magnet_uris,
      type,
      postedAt,
      catalogId,
    });
    log.debug('Successfully scraped detail page.', {
      title: raw_title,
      type,
      catalogId,
    });
  } else {
    log.warning(`No magnet links found on detail page for "${raw_title}"`, {
      url: request.url,
    });
  }
}

/* ---------- main entry ---------- */
const runCrawler = async () => {
  /* 🔥 FORCE COMPLETE STATE RESET 🔥 */
  try {
    logger.info('Purging default storages to ensure a fresh crawl...');
    await purgeDefaultStorages();

    Configuration.getGlobalConfig().set('persistStorage', false);

    await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    logger.warn('Non-fatal purge warning:', err.message);
  }

  const crawledData = [];
  const crawler = createCrawler(crawledData);

  /* ---------- build start requests (always fresh) ---------- */
  const startRequests = [];
  const runTimestamp = Date.now();

  const addScrapeTasks = (urls, type, catalogId) => {
    urls.forEach((baseUrl) => {
      const cleanBaseUrl = baseUrl.replace(/\/$/, '');
      for (let i = config.scrapeStartPage; i <= config.scrapeEndPage; i++) {
        const base = i === 1 ? cleanBaseUrl : `${cleanBaseUrl}/page/${i}`;
        const withSort = appendQuery(base, config.forumSortQuery);
        startRequests.push({
          url: withSort,
          uniqueKey: `${withSort}-${runTimestamp}`,
          label: 'LIST',
          userData: { type, catalogId },
        });
      }
    });
  };

  addScrapeTasks(config.seriesForumUrls, 'series', 'top-series-from-forum');
  addScrapeTasks(config.movieForumUrls, 'movie', 'tamil-hd-movies');
  addScrapeTasks(config.dubbedMovieForumUrls, 'movie', 'tamil-dubbed-movies');

  /* ---------- kick off ---------- */
  const logInfo = {
    totalRequests: startRequests.length,
    forumCount:
      config.seriesForumUrls.length +
      config.movieForumUrls.length +
      config.dubbedMovieForumUrls.length,
    hasForumSortQuery: !!config.forumSortQuery,
  };

  if (config.isProxyEnabled) {
    logger.info(
      { ...logInfo, proxyCount: config.proxyUrls.length },
      'Starting crawl using proxies.'
    );
  } else {
    logger.info(logInfo, 'Starting direct crawl.');
  }

  await crawler.run(startRequests);

  logger.info(
    `✅ Crawl run has completed. Scraped ${crawledData.length} total threads with magnets.`
  );
  return crawledData;
};

module.exports = { runCrawler };