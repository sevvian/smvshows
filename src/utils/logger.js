const pino = require('pino');
const config = require('../config/config');

// Enable pretty logs only when not in production AND when stdout is a TTY (local dev)
const isProduction = process.env.NODE_ENV === 'production';
const isTty = process.stdout && process.stdout.isTTY;

let logger;

if (!isProduction && isTty) {
  // Use pino v8 transport configuration with pino-pretty as a prettifier
  // Note: pino-pretty is a devDependency; this block will not run in production images
  logger = pino({
    level: config.logLevel,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  });
} else {
  // Production or non-TTY: structured JSON logs (no pretty transport)
  logger = pino({
    level: config.logLevel,
  });
}

module.exports = logger;