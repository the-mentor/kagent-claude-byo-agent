import { app } from './server';

const PORT = parseInt(process.env.PORT ?? '80', 10);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude BYO agent listening on :${PORT}`);
});

function shutdown(signal: string) {
  console.log(`\nReceived ${signal}, shutting down…`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  // Force exit if connections don't drain within 5s
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
