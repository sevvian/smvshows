Based on your requirements and the official TorBox API research, here is a detailed implementation plan for a torbox.js service wrapper. It mirrors the interface of your existing realdebrid.js module exactly, so the upper-layer application can call the same functions (addMagnet, getTorrentInfo, selectFiles, unrestrictLink, addAndSelect) without any code changes—just swap the service module based on configuration.

Implementation Plan for torbox.js
1. Module Setup & Configuration
javascript
const axios = require('axios');
const logger = require('../utils/logger');
const config = require('../config/config');

// Custom error class – identical to Real-Debrid version
class ResourceNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ResourceNotFoundError';
    }
}
Enable/disable logic
Same pattern as RD:

javascript
if (!config.isTorboxEnabled) {
    logger.info('TorBox service is disabled: No API key provided.');
    module.exports = { isEnabled: false };
} else {
    // ... all functions
}
Axios instance

javascript
const tbApi = axios.create({
    baseURL: 'https://api.torbox.app/v1/api',
    headers: { Authorization: `Bearer ${config.torboxApiKey}` },
    timeout: 15000
});
2. Internal State Caches
Because TorBox does not natively support a “select files” step, and its getTorrentInfo endpoint identifies torrents by hash (not the numeric id returned by addMagnet), you must keep two lightweight in‑memory caches:

torrentIdToHash – Map<number, string> – maps the numeric torrent ID to its hash.

torrentSelections – Map<number, Set<number>> – maps torrent ID to a set of selected file_ids.

These caches will be populated during addMagnet and selectFiles, and consulted in getTorrentInfo to return correctly shaped data.

Note: For production resilience, you could later replace these with a simple file‑based or database‑backed store, but an in‑memory Map is sufficient to meet the “no code changes” requirement for the caller.

3. Function‑by‑Function Implementation
3.1 addMagnet(magnet)
TorBox API:
POST /api/torrents/createtorrent

Content‑Type: multipart/form-data

Field: magnet (string)

Expected response:
A torrent object containing at least id (integer) and hash (string).

Implementation:

javascript
async function addMagnet(magnet) {
    try {
        const formData = new URLSearchParams();
        formData.append('magnet', magnet);
        const response = await tbApi.post('/torrents/createtorrent', formData, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const data = response.data;
        // Cache the mapping for later use
        if (data && data.id && data.hash) {
            torrentIdToHash.set(data.id, data.hash);
        }
        return data;  // The caller gets the full response (must contain `id`)
    } catch (error) {
        logger.error({ err: error.response?.data || error.message, magnet }, 'Failed to add magnet to TorBox.');
        throw error;
    }
}
3.2 getTorrentInfo(id)
TorBox API:
GET /api/torrents/torrentinfo?hash=<hash>

Because the caller passes the same numeric id that was returned by addMagnet, you must first look up the hash:

Retrieve hash = torrentIdToHash.get(id).

If not found, throw ResourceNotFoundError.

Call GET /api/torrents/torrentinfo?hash=${hash}.

Data transformation – Convert the TorBox response into the Real‑Debrid‑style object:

id → the numeric id (same as input)

filename → response.name

status → map TorBox status strings to Real‑Debrid equivalents:

"downloading" → "downloading"

"completed" / "seeding" → "downloaded"

"error" → "error"

(any other) → "queued" or keep as‑is

files – for each file in response.files:

javascript
{
    id: file.id,            // TorBox file_id (integer)
    path: file.name,        // File name
    bytes: file.size,       // Size in bytes
    selected: torrentSelections.get(id)?.has(file.id) ? 1 : 0
}
links – array of download links only for selected files when the torrent is ready (status "downloaded").
To avoid numerous API calls, generate the links lazily and cache them per file.
Use GET /api/torrents/requestdl?token=<apikey>&torrent_id=<id>&file_id=<fid> (optionally &redirect=false to get a JSON response with the URL).

javascript
// Inside getTorrentInfo, after getting the raw data:
const selectedFileIds = torrentSelections.get(id) || new Set();
const links = [];
if (torrentStatus === 'downloaded' && selectedFileIds.size > 0) {
    for (const fid of selectedFileIds) {
        const dlLink = await requestDownloadLink(id, fid); // helper function
        links.push(dlLink);
    }
}
The helper requestDownloadLink would call the TorBox requestdl endpoint, cache the result, and return the direct download URL.

Error handling: If the TorBox endpoint returns a 404 (torrent not found/hash invalid), throw ResourceNotFoundError to match the RD module’s behaviour.

Full function skeleton:

javascript
async function getTorrentInfo(id) {
    try {
        const hash = torrentIdToHash.get(id);
        if (!hash) throw new ResourceNotFoundError(`Torrent ID ${id} not found.`);
        const { data } = await tbApi.get('/torrents/torrentinfo', { params: { hash } });
        // Map status, build files array, generate links for selected files
        // ...
        return transformedObject;
    } catch (error) {
        if (error.response?.status === 404) {
            throw new ResourceNotFoundError(`Torrent ID ${id} not found on TorBox.`);
        }
        logger.error({ err: error.response?.data || error.message }, `Failed to get torrent info for ID: ${id}`);
        throw error;
    }
}
3.3 selectFiles(id, fileIds = 'all')
Real‑Debrid: sends a POST to actually select files.
TorBox: has no such endpoint; all files are always available. You therefore simulate the selection by updating the local cache.

javascript
async function selectFiles(id, fileIds = 'all') {
    try {
        if (fileIds === 'all') {
            // Fetch the list of all file IDs from the torrent info (without links)
            const info = await getRawTorrentInfo(id); // a helper that returns raw TorBox file list
            const allIds = info.files.map(f => f.id);
            torrentSelections.set(id, new Set(allIds));
        } else {
            const ids = String(fileIds).split(',').map(Number);
            if (!torrentSelections.has(id)) {
                torrentSelections.set(id, new Set());
            }
            const set = torrentSelections.get(id);
            ids.forEach(fid => set.add(fid));
        }
        return true;
    } catch (error) {
        if (error instanceof ResourceNotFoundError) throw error;
        // If the torrent ID is unknown to us (not in hash map), treat as not found
        if (!torrentIdToHash.has(id)) {
            throw new ResourceNotFoundError(`Torrent ID ${id} not found.`);
        }
        logger.error({ err: error.response?.data || error.message }, `Failed to select files for torrent ID: ${id}`);
        throw error;
    }
}
Note: The helper getRawTorrentInfo should call the same torrentinfo endpoint but only return the file list, to avoid infinite recursion and link generation overhead.

3.4 unrestrictLink(link)
Real‑Debrid: used to convert hoster links (Rapidgator, etc.) into debrid download links.
TorBox: does not offer a hoster unrestriction API. Therefore, you have two options:

Throw a clear “not supported” error – if the upper‑layer app only calls this for hoster links when TorBox is the debrid provider, an error is the honest approach.

Return a dummy response – only if you are certain the app will never actually rely on the result for downloading, and you want to avoid runtime crashes.
The dummy could be: { download: link, filename: 'unsupported', filesize: 0 }.

For a clean integration, implement the error version and document the limitation:

javascript
async function unrestrictLink(link) {
    logger.warn('unrestrictLink is not supported by TorBox – hoster unrestriction is unavailable.');
    throw new Error('TorBox does not support hoster link unrestriction. Use direct torrent download.');
}
The caller must handle this if it ever uses hoster links.

3.5 addAndSelect(magnet)
Identical in flow to the Real‑Debrid version:

javascript
async function addAndSelect(magnet) {
    try {
        const addResponse = await addMagnet(magnet);
        const torrentId = addResponse.id;
        if (torrentId) {
            await selectFiles(torrentId, 'all');
            return await getTorrentInfo(torrentId);
        }
        return null;
    } catch (error) {
        logger.error({ err: error.response?.data || error.message }, 'Failed during addAndSelect process.');
        return null;
    }
}
4. Export Identical Interface
javascript
module.exports = {
    isEnabled: true,
    addMagnet,
    getTorrentInfo,
    selectFiles,
    unrestrictLink,
    addAndSelect,
    ResourceNotFoundError
};
The isEnabled flag ensures the upper app can check before using the service, exactly like with Real‑Debrid.

5. Integration Guidelines
Configuration: Add a torboxApiKey to your config and an isTorboxEnabled check.

Switching Services: In the main app, import the active service based on config:

javascript
const debridService = config.useTorbox ? require('./services/torbox') : require('./services/realdebrid');
The rest of the code uses debridService.addMagnet(), debridService.getTorrentInfo(), etc., with no changes.

Error Handling: Both modules throw ResourceNotFoundError under the same conditions, so your polling/error‑recovery logic works seamlessly.

This plan gives you a drop‑in replacement that respects the Real‑Debrid interface while using the TorBox API under the hood, complete with state caching and response normalisation. If you need further clarification on any step or the exact mapping of statuses, feel free to ask!

