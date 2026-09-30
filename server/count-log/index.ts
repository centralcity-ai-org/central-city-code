/* Verifiable agent count: wiring entry (server/app.ts registers the migration and routes). */
export { countLogMigration, registerCountLogMigration, COUNT_LOG_TABLES } from './schema.js';
export { createCountLog, type CountLog } from './service.js';
export { registerCountLogRoutes } from './routes.js';
export { DEFAULT_WITNESS, parseWitnessTarget, witnessFile } from './witness.js';
