import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Operator } from '../shared/types';
import { api, selectedWorkspaceId } from './api';
import { Auth } from './Auth';
import { CityMark } from './brand';
import { ErrorBoundary, markRendered } from './shell/ErrorBoundary';
import { NotFound } from './shell/NotFound';
import { INVITE_ROOMS_PATH, isRoomsPath, navigate, setSignedIn } from './shell/navigation';
import { pendingJoinPath, safeNext } from './rooms/pendingJoin';

/*
 * The entry chunk: session check, hash routing and the 404. Every screen is its own lazily
 * loaded chunk, so the landing page never downloads the console.
 */
const loadLanding = () => import('./Landing');
const loadInvite = () => import('./Invite');
const loadDowntown = () => import('./Downtown');
const loadDocs = () => import('./docs/DocsPages');
const loadVerify = () => import('./verify/VerifyPage');
const loadConnect = () => import('./Connect');
const loadApp = () => import('./App');
const loadRooms = () => import('./RoomsShell');
const loadTrust = () => import('./Trust');
/** The public trust and company pages (src/Trust.tsx); kept here so the entry chunk stays small. */
const TRUST_PATH =
  /^\/(privacy|privacy-choices|terms|acceptable-use|dpa|imprint|security|support|status|about|contact)\/?$/;
function trustPage(pathname: string) {
  return (TRUST_PATH.exec(pathname)?.[1] ?? null) as import('./Trust').TrustPageId | null;
}
/** Mirrors RoomsShell's CREATE_FIRST_ROOM_STATE (kept here so the entry chunk stays small). */
const CREATE_FIRST_ROOM_STATE = 'createFirstRoom';
const Landing = lazy(() => loadLanding().then((module) => ({ default: module.Landing })));
const InvitePage = lazy(() => loadInvite().then((module) => ({ default: module.InvitePage })));
const Downtown = lazy(() => loadDowntown().then((module) => ({ default: module.Downtown })));
const DocsPage = lazy(() => loadDocs().then((module) => ({ default: module.DocsPage })));
const VerifyPage = lazy(() => loadVerify().then((module) => ({ default: module.VerifyPage })));
const ConnectPage = lazy(() => loadConnect().then((module) => ({ default: module.ConnectPage })));
const Workspaces = lazy(() => loadApp().then((module) => ({ default: module.Workspaces })));
// The Rooms experience (/rooms, /rooms/:id, /r/:slug) is its own chunk too.
const RoomsShell = lazy(loadRooms);
const TrustPage = lazy(() => loadTrust().then((module) => ({ default: module.TrustPage })));

/**
 * Starts the likely screen's chunk at startup, in parallel with the session request, so the
 * split adds no extra round trip. The browser caches the module, so React.lazy reuses it.
 */
/** A failed prefetch is reported by the lazy import that follows; don't log it twice. */
const ignorePrefetchFailure = () => undefined;

export function prefetchInitialScreen() {
  if (/^\/downtown\/?$/.test(window.location.pathname))
    return void loadDowntown().catch(ignorePrefetchFailure);
  if (trustPage(window.location.pathname)) return void loadTrust().catch(ignorePrefetchFailure);
  if (/^\/downtown\/verify\/?$/.test(window.location.pathname))
    return void loadVerify().catch(ignorePrefetchFailure);
  if (/^\/docs(?:\/[a-z]+)?\/?$/.test(window.location.pathname))
    return void loadDocs().catch(ignorePrefetchFailure);
  if (!knownPath(window.location.pathname)) return;
  if (isRoomsPath(window.location.pathname)) return void loadRooms().catch(ignorePrefetchFailure);
  if (/^\/invite\/?$/.test(window.location.pathname))
    return void loadInvite().catch(ignorePrefetchFailure);
  const route = routeFromHash();
  // Signed-in visitors land on the console from any hash; the session decides, so a
  // signed-out first visit to / loads only the landing chunk.
  if (route === 'connect') void loadConnect().catch(ignorePrefetchFailure);
  // Sign-in renders from the entry; fetch the console it leads to in the background.
  else if (route === 'signin') void loadApp().catch(ignorePrefetchFailure);
  else void loadLanding().catch(ignorePrefetchFailure);
}

/** How long the first session read may take before the page offers Retry. */
export const SESSION_DEADLINE_MS = 12_000;

/** Paths the SPA renders today: / plus the pages below and the room pages (shared/routes.ts). */
const KNOWN_PATHS = new Set([
  '/',
  '/index.html',
  '/about',
  '/connect',
  '/invite',
  '/signin',
  '/downtown',
  '/downtown/verify',
  '/docs',
  '/docs/start',
  '/docs/rooms',
  '/docs/api',
]);
export function knownPath(pathname: string) {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return KNOWN_PATHS.has(path) || isRoomsPath(path);
}

/**
 * /signin?next=…: where to go after signing in. Room paths (see safeNext), or /invite, which
 * continues the first run into the person's room with its Invite sheet.
 */
function signInNext() {
  const next = new URLSearchParams(window.location.search).get('next');
  return next === '/invite' ? INVITE_ROOMS_PATH : safeNext(next);
}

/**
 * Where a NEW account goes: the console Overview ("/"), unless the person came with a purpose:
 * an explicit room in `next` (/rooms/<id> or /r/<code>), `next=/invite` (the first-room flow),
 * or a pending join (/r/<code> opened before signing up). A #claim= link is handled by its
 * caller. Plain sign-ins keep signInNext() / Rooms.
 */
function registeredNext() {
  const next = new URLSearchParams(window.location.search).get('next');
  if (next === '/invite') return INVITE_ROOMS_PATH;
  if (next && next !== '/rooms' && safeNext(next) === next) return next;
  return pendingJoinPath() ?? '/';
}

/** Go to a post-sign-in destination; the invite path also asks for the first room. */
function continueTo(next: string) {
  if (next === INVITE_ROOMS_PATH) {
    // The person asked for their link ("Sign in to get your link"): the app may create their
    // first room without a second click (see RoomsShell).
    window.history.replaceState({ [CREATE_FIRST_ROOM_STATE]: true }, '', next);
    window.dispatchEvent(new PopStateEvent('popstate'));
  } else navigate(next, true);
}

type PublicRoute = 'home' | 'connect' | 'signin';
function routeFromHash(hash = window.location.hash): PublicRoute {
  if (hash === '#connect') return 'connect';
  if (hash === '#signin' || hash === '#create' || hash.startsWith('#claim=')) return 'signin';
  return 'home';
}

function Boot({ children }: { children?: ReactNode }) {
  return (
    <div className="boot-screen">
      <CityMark />
      <p className="boot-title">Central City</p>
      {children ?? (
        <p>
          <LoaderCircle className="spin" size={15} aria-hidden="true" />
          Opening Central City
        </p>
      )}
    </div>
  );
}

function Rendered({ children }: { children: ReactNode }) {
  useEffect(markRendered, []);
  return children;
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary>
      <Suspense fallback={<Boot />}>
        <Rendered>{children}</Rendered>
      </Suspense>
    </ErrorBoundary>
  );
}

export function Root() {
  const [session, setSession] = useState<{
    operator: Operator | null;
    setupRequired: boolean;
  } | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [route, setRoute] = useState<PublicRoute>(() => routeFromHash());
  // Path routing for /signin and the room pages; RoomsApp and navigate() announce via popstate.
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const change = () => setPath(window.location.pathname);
    window.addEventListener('popstate', change);
    return () => window.removeEventListener('popstate', change);
  }, []);
  const signedIn = Boolean(session?.operator);
  useEffect(() => setSignedIn(signedIn), [signedIn]);
  // Signed in on /signin: go straight to where sign-in would have returned.
  useEffect(() => {
    if (signedIn && path === '/signin') navigate(signInNext(), true);
  }, [signedIn, path]);
  // Signed in on /invite: "Invite your AI" is the person's room with its Invite sheet (§3.2, E1).
  useEffect(() => {
    if (signedIn && /^\/invite\/?$/.test(path)) navigate(INVITE_ROOMS_PATH, true);
  }, [signedIn, path]);
  const publicPath = /^\/downtown\/?$/.test(path);
  const trust = trustPage(path);
  const known = knownPath(path);
  // The session is read on public pages too (not awaited there), so a signed-in visitor's
  // "Invite your AI" goes to their room.
  useEffect(() => {
    if (!known) return;
    let active = true;
    // A stalled session read (cold start, mid-deploy) ends in the Retry state, not an endless
    // "Opening Central City".
    const controller = new AbortController();
    let timedOut = false;
    const deadline = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SESSION_DEADLINE_MS);
    void api<{ operator: Operator | null; setupRequired: boolean }>(
      '/api/session',
      undefined,
      'GET',
      controller.signal,
    )
      .then((value) => {
        if (active) {
          setSession(value);
          setSessionError('');
        }
      })
      .catch((error) => {
        if (!active) return;
        setSessionError(
          timedOut
            ? 'Central City is taking too long to answer.'
            : error instanceof Error
              ? error.message
              : "We couldn't reach Central City.",
        );
      })
      .finally(() => window.clearTimeout(deadline));
    return () => {
      active = false;
      window.clearTimeout(deadline);
      controller.abort();
    };
  }, [sessionAttempt, known]);
  useEffect(() => {
    const change = () => {
      const next = routeFromHash();
      setRoute(next);
      // Moving to sign-in in-page: fetch the console it leads to in the background.
      if (next === 'signin') void loadApp().catch(ignorePrefetchFailure);
      const target = window.location.hash.slice(1);
      const element = /^[a-z-]+$/.test(target) ? document.getElementById(target) : null;
      if (next === 'home' && element) {
        element.scrollIntoView();
        element.focus({ preventScroll: true });
      } else window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  // Public open-source page: same for signed-out and signed-in visitors, no session needed.
  if (publicPath)
    return (
      <Screen>
        <Downtown />
      </Screen>
    );
  // Trust pages: public, the same for every visitor, no session needed.
  if (trust)
    return (
      <Screen>
        <TrustPage page={trust} />
      </Screen>
    );
  // "Verify here": the public, in-browser verification of the agent count (no session needed;
  // the page asks for one only to check the visitor's own agent).
  const docs = /^\/docs(?:\/(start|rooms|api))?\/?$/.exec(path);
  if (docs)
    return (
      <Screen>
        <DocsPage page={(docs[1] ?? 'index') as 'index' | 'start' | 'rooms' | 'api'} />
      </Screen>
    );
  if (/^\/downtown\/verify\/?$/.test(path))
    return (
      <Screen>
        <VerifyPage />
      </Screen>
    );
  // Hash routing still decides the view; any other path is a 404.
  if (!known) return <NotFound />;
  if (!session)
    return sessionError ? (
      <Boot>
        <p role="alert">{sessionError}</p>
        <button
          className="button primary"
          onClick={() => {
            setSessionError('');
            setSessionAttempt((value) => value + 1);
          }}
        >
          Try again
        </button>
      </Boot>
    ) : (
      <Boot />
    );
  if (!session.operator) {
    // Room pages handle signed-out visitors themselves (join screen, "Sign in to join").
    if (isRoomsPath(path))
      return (
        <Screen>
          <RoomsShell signedIn={false} workspaceId="" accountName="" />
        </Screen>
      );
    if (path === '/invite' || path === '/invite/')
      return (
        <Screen>
          <InvitePage />
        </Screen>
      );
    if (path === '/signin')
      return (
        <Screen>
          <Auth
            initialRegister={session.setupRequired}
            claimPending={false}
            onSuccess={(operator, { registered }) => {
              continueTo(registered ? registeredNext() : signInNext());
              setSession({ operator, setupRequired: false });
            }}
          />
        </Screen>
      );
    if (route === 'connect')
      return (
        <Screen>
          <ConnectPage />
        </Screen>
      );
    if (route === 'signin')
      return (
        <Screen>
          {/* Not lazy: see src/Auth.tsx. The console chunk is fetched in the background. */}
          <Auth
            key={window.location.hash === '#create' ? 'create' : 'signin'}
            initialRegister={session.setupRequired || window.location.hash === '#create'}
            claimPending={window.location.hash.startsWith('#claim=')}
            onSuccess={(operator, { registered }) => {
              // Claiming agents continues in the console. A new account starts on the Overview
              // (or where it came to go); a plain sign-in lands on Rooms.
              if (!window.location.hash.startsWith('#claim='))
                continueTo(registered ? registeredNext() : '/rooms');
              setSession({ operator, setupRequired: false });
            }}
          />
        </Screen>
      );
    return (
      <Screen>
        <Landing setupRequired={session.setupRequired} />
      </Screen>
    );
  }
  if (path === '/invite' || path === '/invite/') {
    // Signed in: the effect above moves on to the person's room with its Invite sheet.
    return <Boot />;
  }
  if (isRoomsPath(path)) {
    // The workspace chosen in the console (api.ts keeps it; requests carry X-City-Workspace).
    const workspaceId = selectedWorkspaceId() ?? session.operator.id;
    return (
      <Screen>
        <RoomsShell signedIn workspaceId={workspaceId} accountName={session.operator.name} />
      </Screen>
    );
  }
  return (
    <Screen>
      <Workspaces
        person={session.operator}
        onLogout={() => {
          setRoute('signin');
          window.history.replaceState(null, '', '/#signin');
          setPath('/');
          setSession({ operator: null, setupRequired: false });
        }}
      />
    </Screen>
  );
}
