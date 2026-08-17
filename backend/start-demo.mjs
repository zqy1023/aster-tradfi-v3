process.env.V3_ALLOW_DEMO = 'true';
process.env.AI_PROVIDER = 'mock';
await import('./server.mjs');

