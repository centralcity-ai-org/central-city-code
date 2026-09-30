import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createBridge, loadConfig } from './bridge.js';

async function main() {
  if (process.argv.length !== 4 || process.argv[2] !== '--config')
    throw new Error('Invalid arguments');
  const config = await loadConfig(process.argv[3]!);
  const handle = serveStdio(() => createBridge(config), {
    transport: new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: 64 * 1024,
    }),
    onerror: () => {
      process.stderr.write('Central City MCP protocol error.\n');
    },
  });
  const close = () => {
    void handle.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
main().catch(() => {
  process.stderr.write(
    'Central City MCP could not start. Check --config and the private configuration file.\n',
  );
  process.exitCode = 1;
});
