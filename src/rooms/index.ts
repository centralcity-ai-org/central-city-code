/** Public surface of the Rooms experience for the app shell (docs/ROOMS_UX.md). */
export { RoomsApp } from './RoomsApp';
export { createHttpRoomsClient } from './api';
export type { RoomsClient, Room, RoomMessage, Member } from './api';
export { capturePendingJoin, readPendingJoin, clearPendingJoin, safeNext } from './pendingJoin';
