// src/database/crud.js
const { models } = require('./connection');
const { Op } = require('sequelize');

const findThreadByHash = (hash) => models.Thread.findByPk(hash);

const createOrUpdateThread = (data, options = {}) => {
    return models.Thread.upsert(data, {
        ...options, // Pass transaction/other options here
        conflictFields: ['thread_hash'] 
    });
};

const logFailedThread = (hash, raw_title, reason, options = {}) => models.FailedThread.upsert({ thread_hash: hash, raw_title, reason, last_attempt: new Date() }, options);

// FIX: Ensure this function returns all the necessary fields from the stream model.
// Using `raw: true` is a good practice for read-only queries.
const findStreams = (tmdb_id, season, episode) => models.Stream.findAll({
    where: { tmdb_id, season, episode },
    order: [['quality', 'DESC']], 
    raw: true, // Return plain data objects
});

const createStreams = (streams, options = {}) => models.Stream.bulkCreate(streams, { ...options, ignoreDuplicates: true });

module.exports = {
    findThreadByHash,
    createOrUpdateThread,
    logFailedThread,
    findStreams,
    createStreams,
};
