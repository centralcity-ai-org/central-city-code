import { runCanary } from './index.mjs';
import { loginCanary } from './login.mjs';
try {
  const result = await runCanary({
    origin: process.env.CANARY_ORIGIN ?? 'https://centralcity.ai',
    cookie:
      process.env.CANARY_COOKIE ??
      (await loginCanary({
        origin: process.env.CANARY_ORIGIN ?? 'https://centralcity.ai',
        name: process.env.CANARY_ACCOUNT_NAME,
        password: process.env.CANARY_PASSWORD,
      })),
    ownerId: process.env.CANARY_OWNER_ID,
    senderId: process.env.CANARY_SENDER_ID,
    recipientId: process.env.CANARY_RECIPIENT_ID,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  // Only the runner's bounded errors are surfaced; never HTTP bodies or credentials.
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
