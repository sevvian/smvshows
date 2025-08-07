const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const Thread = sequelize.define('Thread', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        thread_hash: { type: DataTypes.STRING, unique: true, allowNull: false },
        raw_title: { type: DataTypes.STRING, allowNull: false },
        clean_title: DataTypes.STRING,
        year: DataTypes.INTEGER,
        tmdb_id: { type: DataTypes.STRING, references: { model: 'tmdb_metadata', key: 'tmdb_id' }, allowNull: true },
        status: { type: DataTypes.STRING, defaultValue: 'linked', allowNull: false },
        type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'series' },
        postedAt: { type: DataTypes.DATE, allowNull: true },
        catalog: { type: DataTypes.STRING, allowNull: true },
        magnet_uris: { type: DataTypes.JSON, allowNull: true },
        custom_poster: { type: DataTypes.STRING, allowNull: true },
        custom_description: { type: DataTypes.TEXT, allowNull: true },
        last_seen: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, { 
        tableName: 'threads', 
        timestamps: true,
        indexes: [
            { fields: ['status'] },
            { fields: ['type'] },
            { fields: ['catalog'] },
            { fields: ['postedAt'] },
            { fields: ['tmdb_id'] },
            { unique: true, fields: ['thread_hash'] },
        ]
    });

    const TmdbMetadata = sequelize.define('TmdbMetadata', {
        tmdb_id: { type: DataTypes.STRING, primaryKey: true },
        imdb_id: { type: DataTypes.STRING, unique: true },
        year: { type: DataTypes.INTEGER, index: true },
        data: { type: DataTypes.JSON, allowNull: false },
    }, { 
        tableName: 'tmdb_metadata', 
        timestamps: true,
        indexes: [
            { unique: true, fields: ['imdb_id'] },
            { fields: ['year'] },
        ]
    });
    
    const Stream = sequelize.define('Stream', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        tmdb_id: { type: DataTypes.STRING, allowNull: false },
        season: { type: DataTypes.INTEGER, allowNull: true },
        episode: { type: DataTypes.INTEGER, allowNull: true },
        episode_end: { type: DataTypes.INTEGER, allowNull: true },
        infohash: { type: DataTypes.STRING, allowNull: false, unique: true },
        quality: DataTypes.STRING,
        language: DataTypes.STRING,
    }, { 
        tableName: 'streams', 
        timestamps: true,
        indexes: [
            { unique: true, fields: ['tmdb_id', 'season', 'episode', 'infohash'] },
            { fields: ['tmdb_id'] },
            { fields: ['season'] },
            { fields: ['episode'] },
            { fields: ['quality'] },
        ]
    });

    const RdTorrent = sequelize.define('RdTorrent', {
        infohash: { type: DataTypes.STRING, primaryKey: true },
        rd_id: { type: DataTypes.STRING, allowNull: false, unique: true },
        status: { type: DataTypes.STRING, allowNull: false },
        files: { type: DataTypes.JSON, allowNull: true },
        links: { type: DataTypes.JSON, allowNull: true },
        last_checked: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, { tableName: 'rd_torrents', timestamps: true });

    const FailedThread = sequelize.define('FailedThread', {
        thread_hash: { type: DataTypes.STRING, primaryKey: true },
        raw_title: DataTypes.STRING,
        reason: DataTypes.STRING,
        last_attempt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, { tableName: 'failed_threads', timestamps: false, indexes: [{ fields: ['last_attempt'] }] });

    // New: lock table for RD cache to avoid duplicates
    const RdCacheLock = sequelize.define('RdCacheLock', {
        infohash: { type: DataTypes.STRING, primaryKey: true },
        createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    }, { tableName: 'rd_cache_locks', timestamps: false });

    return { Thread, TmdbMetadata, Stream, FailedThread, RdTorrent, RdCacheLock };
};