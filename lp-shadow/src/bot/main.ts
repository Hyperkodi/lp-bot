import { createService } from '../service/index.js';
import { BOT_COMMANDS, createLpBot } from './bot.js';

async function main(): Promise<void> {
  const service = await createService();
  const token = service.getBotToken();

  if (token.trim().length === 0) {
    console.error('Telegram bot token is empty.');
    await service.close();
    process.exitCode = 1;
    return;
  }

  const bot = createLpBot(token, service);
  let stopping = false;
  const stop = (): void => {
    stopping = true;
    // Rejects when polling has not started yet — that's fine, the `stopping`
    // check below prevents the start; it must not become an unhandled
    // rejection that skips service.close().
    void bot.stop().catch(() => undefined);
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await bot.api.setMyCommands(BOT_COMMANDS);
    // A signal that arrived during startup means: don't start polling at all.
    if (!stopping) {
      await bot.start({
        onStart: (info) => console.log(`LP Shadow bot @${info.username} is polling.`),
      });
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await service.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
