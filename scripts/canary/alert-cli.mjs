import { sendFailureAlert } from './alert.mjs';
try {
  console.log(
    JSON.stringify(
      await sendFailureAlert({
        token: process.env.CANARY_ALERT_TOKEN,
        senderId: process.env.CANARY_ALERT_SENDER_ID,
        deskId: process.env.CANARY_ALERT_DESK_ID,
        runId: process.env.GITHUB_RUN_ID,
      }),
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
