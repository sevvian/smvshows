require('dotenv').config();

const config = {
    // ... existing config ...
    
    // Database Maintenance Configuration
    dbAutoVacuumCron: process.env.DB_AUTO_VACUUM_CRON || null, // Cron expression, e.g., '0 3 * * *' for daily at 3 AM
    dbAutoVacuumEnabled: process.env.DB_AUTO_VACUUM_ENABLED === 'true' || false,
    
    // ... rest of existing config ...
};

module.exports = config;