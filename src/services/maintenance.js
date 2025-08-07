const { sequelize } = require('../database/connection');
const logger = require('../utils/logger');
const config = require('../config/config');

let isMaintenanceRunning = false;

/**
 * Performs database maintenance: checkpoint, vacuum, and analyze
 * Returns statistics about the operation
 */
const performMaintenance = async () => {
    if (isMaintenanceRunning) {
        logger.info('Database maintenance is already running. Skipping.');
        return { status: 'skipped', reason: 'already_running' };
    }

    isMaintenanceRunning = true;
    logger.info('Starting database maintenance...');

    try {
        // Get database size before maintenance
        const beforeSizeResult = await sequelize.query('PRAGMA page_count * page_size AS size');
        const beforeSize = parseInt(beforeSizeResult[0][0].size) || 0;

        // 1. Write-Ahead Logging checkpoint to flush all changes
        await sequelize.query('PRAGMA wal_checkpoint(TRUNCATE)');
        logger.info('WAL checkpoint completed');

        // 2. VACUUM to reclaim free space and defragment
        await sequelize.query('VACUUM');
        logger.info('VACUUM completed');

        // 3. ANALYZE to update query planner statistics
        await sequelize.query('ANALYZE');
        logger.info('ANALYZE completed');

        // Get database size after maintenance
        const afterSizeResult = await sequelize.query('PRAGMA page_count * page_size AS size');
        const afterSize = parseInt(afterSizeResult[0][0].size) || 0;
        const reclaimed = beforeSize - afterSize;

        logger.info({
            beforeSize: `${(beforeSize / 1024 / 1024).toFixed(2)} MB`,
            afterSize: `${(afterSize / 1024 / 1024).toFixed(2)} MB`,
            reclaimed: `${(reclaimed / 1024 / 1024).toFixed(2)} MB`
        }, 'Database maintenance completed successfully');

        return {
            status: 'completed',
            beforeSize,
            afterSize,
            reclaimed,
            timestamp: new Date()
        };

    } catch (error) {
        logger.error(error, 'Database maintenance failed');
        return {
            status: 'failed',
            error: error.message,
            timestamp: new Date()
        };
    } finally {
        isMaintenanceRunning = false;
    }
};

module.exports = {
    performMaintenance,
    isMaintenanceRunning
};