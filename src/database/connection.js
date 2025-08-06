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
        // FIX: Removed `{ alter: true }`. This prevents Sequelize from trying to
        // perform a data migration that fails on existing, invalid data.
        // On startup, it will now simply ensure the tables exist as defined.
        await sequelize.sync(); 
        logger.info('Database & tables verified successfully.');
    } catch (error) {
        logger.error(error, 'Error synchronizing database:');
        // We throw the error here to ensure the application does not start
        // with a faulty database connection.
        throw error;
    }
};

module.exports = { sequelize, models, syncDb };
