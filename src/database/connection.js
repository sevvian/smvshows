// src/database/connection.js
const { Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const defineModels = require('./models');

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: '/data/stremio_addon.db',
    logging: msg => logger.debug(msg),
});

const models = defineModels(sequelize);

// Define associations between models
if (models.Thread && models.TmdbMetadata) {
    models.Thread.belongsTo(models.TmdbMetadata, { foreignKey: 'tmdb_id', targetKey: 'tmdb_id' });
    models.TmdbMetadata.hasMany(models.Thread, { foreignKey: 'tmdb_id', sourceKey: 'tmdb_id' });
}

const syncDb = async () => {
    try {
        await sequelize.sync();
        logger.info('Database & tables verified successfully.');

        // After DB sync, tell the debrid provider about the TorboxIdMap model
        try {
            const debridFactory = require('../services/debrid');
            const provider = debridFactory.getProvider();
            if (provider && typeof provider.setModels === 'function') {
                provider.setModels(models);
                logger.info('Debrid provider models set successfully.');
            }
        } catch (e) {
            logger.warn('Could not set models on debrid provider:', e.message);
        }
    } catch (error) {
        logger.error(error, 'Error synchronizing database:');
        throw error;
    }
};

module.exports = { sequelize, models, syncDb };
