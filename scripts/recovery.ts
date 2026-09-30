import { backupDatabase, restoreDatabase } from '../server/recovery.js';

const [command, source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length || !['backup', 'restore'].includes(command)) {
  console.error(
    'Usage: pnpm exec tsx scripts/recovery.ts <backup|restore> <source> <new-destination>',
  );
  process.exitCode = 1;
} else {
  try {
    const result =
      command === 'backup'
        ? await backupDatabase(source, destination)
        : await restoreDatabase(source, destination);
    console.log(JSON.stringify({ ok: true, command, ...result }));
  } catch (error) {
    // Validation errors can include sensitive input; never print error objects or backup values.
    console.error(
      error instanceof Error && error.name !== 'ZodError' && error.name !== 'SyntaxError'
        ? error.message
        : 'Invalid or incompatible backup. No recovery was completed.',
    );
    process.exitCode = 1;
  }
}
