/**
 * Room tasks module (claims core, results and lapse). Convenience
 * barrel; the pieces are `tasks-contract.ts` (limits, inputs, views),
 * `tasks-service.ts` (claims core, result/review, the lapse sweep) and
 * `tasks-schema.ts` (migrations 24–25).
 */
export * from './tasks-contract.js';
export * from './tasks-service.js';
export * from './tasks-schema.js';
