/**
 * Telegram transport. Plain fetch against the Bot API — no client library.
 *
 * When TELEGRAM_BOT_TOKEN is empty, reporting is disabled and messages are
 * logged instead. The loop must never die because Telegram is down.
 */
import { errorMessage, log } from '../logger.js';

export type Telegram = {
  enabled: boolean;
  send(text: string): Promise<void>;
};

export function createTelegram(botToken: string, chatId: string): Telegram {
  const enabled = botToken.length > 0 && chatId.length > 0;
  if (!enabled) {
    log.warn('telegram disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)');
  }
  return {
    enabled,
    async send(text: string): Promise<void> {
      if (!enabled) {
        log.info(`[telegram disabled] ${text}`);
        return;
      }
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          log.warn(`telegram sendMessage failed: ${res.status} ${await res.text()}`);
        }
      } catch (err) {
        log.warn(`telegram sendMessage threw: ${errorMessage(err)}`);
      }
    },
  };
}

/** Telegram's HTML parse mode only needs these three escaped. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
