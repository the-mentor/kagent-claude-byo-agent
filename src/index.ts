import { app } from './server';
import { logger } from './logger';

const PORT = parseInt(process.env.PORT ?? '80', 10);

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info({ port: PORT }, 'Claude BYO agent listening');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    logger.info('server closed');
    process.exit(0);
  });
  // Force exit if connections don't drain within 5s
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
