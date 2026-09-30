export const DEFAULT_ORIGIN: string;
export interface Options {
  origin?: string;
  idempotencyKey?: string;
}
export interface Result {
  agentId: string;
  claimUrl: string | null;
  replayed: boolean;
  expiry: string;
}
export function parseOptions(args: string[]): Required<Options>;
export function runQuickstart(options?: Options): Promise<Result>;
export function formatResult(result: Result): string;
