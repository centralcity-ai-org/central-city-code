import type { FastifyInstance } from 'fastify';
import { registerGoogleSignInRoutes, type GoogleSignInDeps } from './routes.js';

/**
 * Sign in with Google (docs/GOOGLE_SIGNIN.md). The schema always exists (migration 41; app.ts
 * registers it after Elric's migration 39, which it extends); the routes answer only behind
 * CITY_GOOGLE_SIGNIN=1 with GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET set.
 */

export function registerGoogleSignIn(app: FastifyInstance, deps: GoogleSignInDeps): void {
  registerGoogleSignInRoutes(app, deps);
}

export { GOOGLE_TABLES, registerGoogleMigration } from './schema.js';
export type { GoogleSignInOptions, GoogleTransport } from './config.js';
export type { GoogleSignInDeps } from './routes.js';
