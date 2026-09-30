import { test, expect, type Browser } from '@playwright/test';

/*
 * E2E tests for the Rooms sidebar and app shell:
 * - Workspace (the main overview, /) above Room list; Room list (/rooms) is an overview of the
 *   person's rooms (never auto-opens one)
 * - New room & Join a room quick action buttons
 * - Grouped rooms (Hosting / Joined Rooms / Closed Rooms) with unread badges & active highlight
 * - Closed rooms collapsible accordion (auto-expands if active room is closed)
 * - Collapsible desktop icon rail (64px, house icon first, uncollapse via brand mark)
 * - Phone drawer (menu button, backdrop, Escape, focus in and back, inert while closed)
 * - Footer with the Dark mode toggle and the user name only
 */

const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function registerAccount(browser: Browser, label: string) {
  const context = await browser.newContext();
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return { context, name, request: context.request, page: await context.newPage() };
}

async function createAgent(account: { request: any }, name: string) {
  const res = await account.request.post('/api/agents', {
    headers,
    data: { name, description: 'Test agent', capability: 'research', mode: 'external' },
  });
  expect(res.ok()).toBeTruthy();
  const data = await res.json();
  return data.agent.id as string;
}

async function createRoom(account: { request: any }, agentId: string, name: string) {
  const res = await account.request.post('/api/rooms', {
    headers,
    data: { agent_id: agentId, name, idempotency_key: crypto.randomUUID() },
  });
  expect(res.status()).toBe(201);
  const data = await res.json();
  return data.room as { id: string; slug: string; name: string };
}

test('sidebar shell: Workspace and Room list, New room and Join a room actions, and user profile in footer', async ({
  browser,
}) => {
  const user = await registerAccount(browser, 'Sidebar-User');
  const agentId = await createAgent(user, 'Primary Agent');
  const room = await createRoom(user, agentId, 'Alpha Room');

  await user.page.goto(`/rooms/${room.id}`);
  const sidebar = user.page.getByRole('navigation', { name: 'Rooms' });
  await expect(sidebar).toBeVisible();

  // Branding mark & text
  await expect(sidebar.getByText('Central City')).toBeVisible();
  await expect(sidebar.locator('.rm-sidebar-brand-mark')).toBeVisible();

  // Workspace (the main overview) first, then Room list (the rooms overview).
  const workspaceLink = sidebar.getByRole('link', { name: 'Workspace', exact: true });
  const roomListLink = sidebar.getByRole('link', { name: 'Room list', exact: true });
  await expect(workspaceLink).toBeVisible();
  await expect(workspaceLink).toHaveAttribute('href', '/');
  await expect(roomListLink).toBeVisible();
  await expect(roomListLink).toHaveAttribute('href', '/rooms');
  await expect(sidebar.getByRole('link', { name: 'Home', exact: true })).toHaveCount(0);
  const [workspaceBox, roomListBox] = await Promise.all([
    workspaceLink.boundingBox(),
    roomListLink.boundingBox(),
  ]);
  expect(workspaceBox!.y).toBeLessThan(roomListBox!.y);

  // Quick actions
  await expect(sidebar.getByRole('button', { name: 'New room' })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Join a room' })).toBeVisible();

  // Grouping: Hosting section
  await expect(sidebar.getByText('Hosting (1)')).toBeVisible();
  const roomItem = sidebar.getByRole('link', { name: 'Alpha Room' });
  await expect(roomItem).toBeVisible();
  await expect(roomItem).toHaveAttribute('aria-current', 'page');

  // Footer: Dark mode and the user name only (no Preferences link)
  await expect(sidebar.getByRole('link', { name: 'Preferences' })).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: 'Workspace', exact: true })).toHaveCount(1);

  const themeToggle = sidebar.getByRole('button', { name: /Dark mode|Light mode/ });
  await expect(themeToggle).toBeVisible();

  // User name only in profile card (no role, no avatar letter)
  const profileCard = sidebar.locator('.rm-sidebar-profile-card');
  await expect(profileCard).toBeVisible();
  await expect(profileCard).toContainText(user.name);
  await expect(profileCard.locator('.profile-avatar')).toHaveCount(0);

  // The account card opens Sign out only (Workspace is in the sidebar).
  const account = sidebar.getByRole('button', { name: user.name });
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await account.click();
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  const menu = sidebar.getByRole('menu', { name: 'Account' });
  await expect(menu.getByRole('menuitem')).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: 'Workspace' })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await user.page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(account).toBeFocused();
  await account.click();
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(user.page).toHaveURL(/\/$/);
  // Signed out: the rooms API no longer answers for this browser.
  expect((await user.page.request.get('/api/rooms')).status()).toBe(401);
});

test('room grouping: Hosting vs Joined vs Closed with accordion and active highlight', async ({
  browser,
}) => {
  const host = await registerAccount(browser, 'Host-User');
  const hostAgent = await createAgent(host, 'Host Agent');
  const hostedRoom = await createRoom(host, hostAgent, 'Hosted Space');

  // Another account creates a room and invites the host
  const other = await registerAccount(browser, 'Other-User');
  const otherAgent = await createAgent(other, 'Other Agent');
  const joinedRoom = await createRoom(other, otherAgent, 'Collaborative Hub');

  // Mint link and host joins
  const linkRes = await other.request.post(`/api/rooms/${joinedRoom.id}/link`, {
    headers,
    data: {},
  });
  expect(linkRes.status()).toBe(200);
  const { link } = await linkRes.json();
  const token = new URL(link).hash.slice(1);

  // Host joins joinedRoom
  const joinRes = await host.request.post(`/api/rooms/${joinedRoom.id}/join`, {
    headers,
    data: { token, create: { name: 'Host As Guest' }, idempotency_key: crypto.randomUUID() },
  });
  expect(joinRes.status()).toBe(200);

  // Host creates another room and closes it
  const closedRoom = await createRoom(host, hostAgent, 'Archived Discussion');
  const closeRes = await host.request.post(`/api/rooms/${closedRoom.id}/close`, {
    headers,
    data: {},
  });
  expect(closeRes.status()).toBe(200);

  // Navigate to hosted room
  await host.page.goto(`/rooms/${hostedRoom.id}`);
  const sidebar = host.page.getByRole('navigation', { name: 'Rooms' });
  await expect(sidebar).toBeVisible();

  // Verify groups
  await expect(sidebar.getByText('Hosting (1)')).toBeVisible();
  await expect(sidebar.getByText('Joined Rooms (1)')).toBeVisible();
  await expect(sidebar.getByText('Closed Rooms (1)')).toBeVisible();

  // Verify hosted room is active
  await expect(sidebar.getByRole('link', { name: 'Hosted Space' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Verify closed rooms accordion toggling
  const closedToggle = sidebar.getByRole('button', { name: /Closed Rooms/ });
  const closedLink = sidebar.getByRole('link', { name: /Archived Discussion/ });

  // Initially closed rooms list is collapsed
  await expect(closedLink).toBeHidden();

  // Click accordion toggle to expand
  await closedToggle.click();
  await expect(closedLink).toBeVisible();

  // Click again to collapse
  await closedToggle.click();
  await expect(closedLink).toBeHidden();

  // When visiting a closed room directly, accordion auto-expands
  await host.page.goto(`/rooms/${closedRoom.id}`);
  await expect(sidebar.getByRole('link', { name: /Archived Discussion/ })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: /Archived Discussion/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('collapsible icon rail: collapses to 64px width, Workspace first, account reachable, uncollapses on brand click', async ({
  browser,
}) => {
  const user = await registerAccount(browser, 'Rail-User');
  const agentId = await createAgent(user, 'Rail Agent');
  const room = await createRoom(user, agentId, 'Rail Lab');

  await user.page.setViewportSize({ width: 1200, height: 800 });
  await user.page.goto(`/rooms/${room.id}`);
  const sidebar = user.page.getByRole('navigation', { name: 'Rooms' });
  await expect(sidebar).toBeVisible();

  // Initially expanded (260px)
  const initialWidth = await sidebar.evaluate((el) => el.getBoundingClientRect().width);
  expect(initialWidth).toBe(260);

  // Click collapse button
  const collapseBtn = sidebar.getByRole('button', { name: 'Collapse sidebar' });
  await collapseBtn.click();

  // Collapsed to 64px icon rail
  await expect
    .poll(async () => sidebar.evaluate((el) => el.getBoundingClientRect().width))
    .toBe(64);

  // Text labels hidden when collapsed
  await expect(sidebar.getByText('Central City')).toBeHidden();
  await expect(sidebar.getByText('Hosting (1)')).toBeHidden();
  await expect(sidebar.locator('.rm-profile-card-name')).toBeHidden();

  // The rail keeps Workspace first, then Room list, as icons.
  const workspaceIcon = sidebar.getByRole('link', { name: 'Workspace', exact: true });
  const roomListIcon = sidebar.getByRole('link', { name: 'Room list', exact: true });
  await expect(workspaceIcon).toBeVisible();
  await expect(roomListIcon).toBeVisible();
  const [workspaceIconBox, roomListIconBox] = await Promise.all([
    workspaceIcon.boundingBox(),
    roomListIcon.boundingBox(),
  ]);
  expect(workspaceIconBox!.y).toBeLessThan(roomListIconBox!.y);

  // Desktop has no drawer button: the sidebar's own collapse control is the only one.
  await expect(user.page.getByRole('button', { name: 'Open menu' })).toBeHidden();

  // The account stays reachable in the rail: an icon button opens the same menu.
  const account = sidebar.getByRole('button', { name: user.name });
  await expect(account).toBeVisible();
  await account.click();
  const accountMenu = sidebar.getByRole('menu', { name: 'Account' });
  await expect(accountMenu.getByRole('menuitem', { name: 'Sign out' })).toBeInViewport();
  await user.page.keyboard.press('Escape');
  await expect(accountMenu).toHaveCount(0);

  // Uncollapse via brand mark click
  const brandWrap = sidebar.locator('.rm-sidebar-brand-wrap');
  await brandWrap.click();

  // Returned to 260px expanded width
  await expect
    .poll(async () => sidebar.evaluate((el) => el.getBoundingClientRect().width))
    .toBe(260);
  await expect(sidebar.getByText('Central City')).toBeVisible();
});

test('mobile drawer: off-canvas under 900px, opened by menu button, closed by backdrop', async ({
  browser,
}) => {
  const user = await registerAccount(browser, 'Mobile-User');
  const agentId = await createAgent(user, 'Mobile Agent');
  const room = await createRoom(user, agentId, 'Mobile Room');

  await user.page.setViewportSize({ width: 390, height: 844 });
  await user.page.goto(`/rooms/${room.id}`);

  const sidebar = user.page.getByRole('navigation', { name: 'Rooms' });

  // Sidebar is off-canvas (not in viewport), with no shadow strip on the left edge
  await expect(sidebar).not.toBeInViewport();
  expect(await sidebar.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');

  // Click top-left menu hamburger button
  const menuBtn = user.page.getByRole('button', { name: 'Open menu' });
  await menuBtn.click();

  // Sidebar slides in as drawer
  await expect(sidebar).toBeInViewport();

  // Backdrop is visible
  const backdrop = user.page.locator('.rm-drawer-backdrop');
  await expect(backdrop).toBeVisible();

  // Click backdrop to dismiss drawer
  await backdrop.click({ position: { x: 350, y: 300 } });
  await expect(sidebar).not.toBeInViewport();
});

test('mobile drawer a11y: inert while closed, focus moves in, Escape closes and focus returns', async ({
  browser,
}) => {
  const user = await registerAccount(browser, 'Drawer-User');
  const agentId = await createAgent(user, 'Drawer Agent');
  const room = await createRoom(user, agentId, 'Drawer Room');

  await user.page.setViewportSize({ width: 390, height: 844 });
  await user.page.goto(`/rooms/${room.id}`);
  const sidebar = user.page.getByRole('navigation', { name: 'Rooms' });
  const menuBtn = user.page.getByRole('button', { name: 'Open menu' });
  await expect(menuBtn).toBeVisible();

  // Closed: the drawer is inert, so Tab never lands inside it.
  await expect(sidebar).toHaveAttribute('inert', '');
  for (let step = 0; step < 12; step++) {
    await user.page.keyboard.press('Tab');
    expect(await sidebar.evaluate((nav) => nav.contains(document.activeElement))).toBe(false);
  }

  // Open: focus moves to the close button inside the drawer.
  await menuBtn.focus();
  await user.page.keyboard.press('Enter');
  await expect(sidebar).toBeInViewport();
  await expect(sidebar).not.toHaveAttribute('inert', '');
  await expect(sidebar.getByRole('button', { name: 'Close rooms' })).toBeFocused();

  // Tab stays inside the open drawer.
  for (let step = 0; step < 15; step++) {
    await user.page.keyboard.press('Tab');
    expect(await sidebar.evaluate((nav) => nav.contains(document.activeElement))).toBe(true);
  }

  // Escape closes it and focus goes back to the menu button.
  await user.page.keyboard.press('Escape');
  await expect(sidebar).not.toBeInViewport();
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect(menuBtn).toBeFocused();
});

test('Room list: /rooms shows the overview of rooms, never a room; Workspace goes to /', async ({
  browser,
}) => {
  const user = await registerAccount(browser, 'Overview-User');
  const agentId = await createAgent(user, 'Overview Agent');
  const first = await createRoom(user, agentId, 'First Room');
  await createRoom(user, agentId, 'Second Room');

  // A direct load of /rooms stays on /rooms and lists the rooms.
  await user.page.goto('/rooms');
  const heading = user.page.getByRole('heading', { level: 1, name: 'Your rooms' });
  await expect(heading).toBeVisible();
  const list = user.page.getByRole('list', { name: 'All rooms' });
  await expect(list.getByRole('link', { name: /First Room/ })).toBeVisible();
  await expect(list.getByRole('link', { name: /Second Room/ })).toBeVisible();
  await expect(list.getByText('Hosting')).toHaveCount(2);
  // New room and Join a room live in the sidebar only, not twice in the overview.
  const overview = user.page.locator('.rm-overview');
  await expect(overview.getByRole('button', { name: 'New room' })).toHaveCount(0);
  await expect(overview.getByRole('button', { name: 'Join a room' })).toHaveCount(0);
  await expect(user.page).toHaveURL(/\/rooms$/);

  // Clicking a room opens it; Room list brings the overview back.
  await list.getByRole('link', { name: /First Room/ }).click();
  await expect(user.page).toHaveURL(new RegExp(`/rooms/${first.id}$`));
  const sidebar = user.page.getByRole('navigation', { name: 'Rooms' });
  const roomList = sidebar.getByRole('link', { name: 'Room list', exact: true });
  await expect(roomList).not.toHaveClass(/active/);
  await roomList.click();
  await expect(user.page).toHaveURL(/\/rooms$/);
  await expect(heading).toBeVisible();
  await expect(roomList).toHaveClass(/active/);

  // Workspace goes to the main overview (/).
  const workspace = sidebar.getByRole('link', { name: 'Workspace', exact: true });
  await expect(workspace).toHaveAttribute('href', '/');
  await workspace.click();
  await expect(user.page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  await expect(
    user.page.getByRole('heading', { level: 1, name: 'Everything, at a glance.' }),
  ).toBeVisible();
});

test('dark mode toggle in footer switches theme attribute', async ({ browser }) => {
  const user = await registerAccount(browser, 'Theme-User');
  const agentId = await createAgent(user, 'Theme Agent');
  const room = await createRoom(user, agentId, 'Theme Room');

  await user.page.goto(`/rooms/${room.id}`);
  const sidebar = user.page.getByRole('navigation', { name: 'Rooms' });

  const themeBtn = sidebar.getByRole('button', { name: /Dark mode|Light mode/ });
  await expect(themeBtn).toBeVisible();

  // Initial theme (default light)
  const initialTheme = await user.page.evaluate(() => document.documentElement.dataset.theme);

  // Toggle theme
  await themeBtn.click();
  const nextTheme = await user.page.evaluate(() => document.documentElement.dataset.theme);
  expect(nextTheme).not.toBe(initialTheme);

  // Toggle back
  await themeBtn.click();
  const finalTheme = await user.page.evaluate(() => document.documentElement.dataset.theme);
  expect(finalTheme).toBe(initialTheme);
});
