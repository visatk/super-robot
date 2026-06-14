import { Bot, Context, webhookCallback, TelegramError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';

export interface Env {
	BOT_TOKEN: string;
	BOT_SECRET_TOKEN: string;
	DB: D1Database;
}

type SuperContext = Context & { cfCtx: ExecutionContext; env: Env };

// Helper: Chunk array for concurrent processing without triggering 429s instantly
const chunkArray = <T>(arr: T[], size: number): T[][] =>
	Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (!env.BOT_TOKEN) return new Response('Critical Error: BOT_TOKEN missing', { status: 500 });

		const bot = new Bot<SuperContext>(env.BOT_TOKEN);

		// AppSec: Handle transient rate limits. Max retry is capped to avoid burning Worker wall-time.
		bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 5 }));

		// Inject dependencies into Grammy context
		bot.use((botCtx, next) => {
			botCtx.cfCtx = ctx;
			botCtx.env = env;
			return next();
		});

		// Middleware: Log members asynchronously to prevent blocking the HTTP response
		bot.on(['message', 'chat_member'], (botCtx, next) => {
			const chatId = botCtx.chat?.id;
			const userId = botCtx.from?.id;

			if (chatId && userId && botCtx.chat?.type !== 'private') {
				// AppSec: Parameterized to prevent SQLi. Backgrounded to guarantee immediate 200 OK to Telegram.
				botCtx.cfCtx.waitUntil(
					botCtx.env.DB.prepare('INSERT OR IGNORE INTO members (chat_id, user_id) VALUES (?, ?)')
						.bind(chatId, userId)
						.run()
						.catch((err) => console.error('Background DB Insert Error:', err))
				);
			}
			return next();
		});

		bot.command('cleandeleted', async (botCtx) => {
			if (botCtx.chat.type === 'private') {
				return botCtx.reply('❌ This command is restricted to groups/supergroups.');
			}

			// AppSec: Strict Authorization
			try {
				const chatAdmins = await botCtx.getChatAdministrators();
				const isAdmin = chatAdmins.some((admin) => admin.user.id === botCtx.from?.id);

				if (!isAdmin && botCtx.from?.id !== botCtx.chat.id && botCtx.from?.username !== 'GroupAnonymousBot') {
					return botCtx.reply('⛔ **Access Denied**: Administrator privileges required.');
				}
			} catch (e) {
				return botCtx.reply('❌ Error verifying admin status. Ensure the bot is an administrator.');
			}

			const chatId = botCtx.chat.id;
			const statusMsg = await botCtx.reply('⏳ Analyzing database and initiating background cleanup...');

			// Run heavy processing in background
			botCtx.cfCtx.waitUntil(
				(async () => {
					try {
						let offset = 0;
						const limit = 1000; // Memory-safe pagination limit
						let hasMore = true;
						let kickedCount = 0;
						let checkedCount = 0;

						while (hasMore) {
							// Optimize memory: Process DB records in chunks rather than loading thousands into memory
							const result = await botCtx.env.DB.prepare('SELECT user_id FROM members WHERE chat_id = ? LIMIT ? OFFSET ?')
								.bind(chatId, limit, offset)
								.all<{ user_id: number }>();

							if (!result.success || !result.results) throw new Error('Database retrieval failed');

							const users = result.results;
							if (users.length < limit) hasMore = false;
							offset += limit;

							// Process API calls concurrently in micro-batches of 15 to balance speed and Telegram rate-limits
							for (const batch of chunkArray(users, 15)) {
								await Promise.allSettled(
									batch.map(async (row) => {
										try {
											checkedCount++;
											const member = await botCtx.api.getChatMember(chatId, row.user_id);

											const isDeletedAccount =
												member.user.first_name === 'Deleted Account' || member.user.first_name === '';

											if (isDeletedAccount && !['left', 'kicked'].includes(member.status)) {
												await botCtx.api.banChatMember(chatId, row.user_id);
												await botCtx.api.unbanChatMember(chatId, row.user_id);
												kickedCount++;

												await botCtx.env.DB.prepare('DELETE FROM members WHERE chat_id = ? AND user_id = ?')
													.bind(chatId, row.user_id)
													.run();
											} else if (['left', 'kicked'].includes(member.status)) {
												// Prune valid accounts that voluntarily left to keep DB size optimal
												await botCtx.env.DB.prepare('DELETE FROM members WHERE chat_id = ? AND user_id = ?')
													.bind(chatId, row.user_id)
													.run();
											}
										} catch (error) {
											// Auto-prune IDs that return 400 Bad Request (User not found)
											if (error instanceof TelegramError && error.description.toLowerCase().includes('user not found')) {
												await botCtx.env.DB.prepare('DELETE FROM members WHERE chat_id = ? AND user_id = ?')
													.bind(chatId, row.user_id)
													.run();
											}
										}
									})
								);
								// Artificial delay to prevent global broadcasting blocks
								await new Promise((res) => setTimeout(res, 800));
							}
						}

						await botCtx.api.editMessageText(
							chatId,
							statusMsg.message_id,
							`✅ **Cleanup Complete**\n\n🔍 Checked: ${checkedCount}\n👻 Ghosts Purged: ${kickedCount}`,
							{ parse_mode: 'Markdown' }
						);
					} catch (error) {
						console.error('Background Task Panic:', error);
						await botCtx.api.editMessageText(
							chatId,
							statusMsg.message_id,
							'❌ The background cleanup task was interrupted due to an error or execution limit.'
						);
					}
				})()
			);
		});

		// AppSec: Enforce X-Telegram-Bot-Api-Secret-Token validation
		const handleUpdate = webhookCallback(bot, 'cloudflare-fetch', {
			secretToken: env.BOT_SECRET_TOKEN,
		});

		return handleUpdate(request);
	},
} satisfies ExportedHandler<Env>;
