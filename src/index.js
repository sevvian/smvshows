// src/index.js
const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');
const cron = require('node-cron');
const path = require('path');

const config = require('./config/config');
const logger = require('./utils/logger');
const { syncDb } = require('./database/connection');
const { runFullWorkflow } = require('./services/orchestrator');
const { fetchAndCacheTrackers } = require('./services/tracker');
const { performMaintenance } = require('./services/maintenance');

const stremioRoutes = require('./api/stremio.routes');
const adminRoutes = require('./api/admin.routes');

const app = express();

async function main() {
    logger.info(`Real-Debrid integration is ${config.isRdEnabled ? 'ENABLED' : 'DISABLED'}.`);
    logger.info(`Database auto-vacuum is ${config.dbAutoVacuumEnabled ? 'ENABLED' : 'DISABLED'}.`);
    
    await syncDb();

    await fetchAndCacheTrackers();

    app.use(cors());
    app.use(express.json());
    app.use(pinoHttp({ logger }));

    app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
    app.use(stremioRoutes);
    app.use('/admin/api', adminRoutes);

    app.listen(config.port, () => {
        logger.info(`Stremio Addon server running on http://localhost:${config.port}`);
    });
    
    runFullWorkflow();
    
    // --- START OF FIX R12 ---
    // Use the configurable cron expression from the config file.
    cron.schedule(config.mainWorkflowCron, () => {
        logger.info('Cron job triggered for main workflow...');
        runFullWorkflow();
    }, { scheduled: true, timezone: "Etc/UTC" });
    // --- END OF FIX R12 ---

    cron.schedule('0 * * * *', () => {
        logger.info('Cron job triggered for tracker update...');
        fetchAndCacheTrackers();
    }, { scheduled: true, timezone: "Etc/UTC" });

    // Database maintenance cron (if enabled)
    if (config.dbAutoVacuumEnabled && config.dbAutoVacuumCron) {
        cron.schedule(config.dbAutoVacuumCron, () => {
            logger.info('Cron job triggered for database maintenance...');
            performMaintenance();
        }, { scheduled: true, timezone: "Etc/UTC" });
        logger.info(`Database maintenance scheduled with cron expression: "${config.dbAutoVacuumCron}"`);
    } else if (config.dbAutoVacuumEnabled) {
        logger.warn('Database maintenance is enabled but no cron expression configured. Set DB_AUTO_VACUUM_CRON.');
    }
    
    logger.info(`Crawler scheduled with cron expression: "${config.mainWorkflowCron}". Tracker list scheduled to update every hour.`);
}

main().catch(err => {
    logger.fatal(err, 'Application failed to start due to a fatal error.');
    process.exit(1);
});