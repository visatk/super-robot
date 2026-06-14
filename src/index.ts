import { Bot, Context, webhookCallback, TelegramError } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';

export interface Env {
	BOT_TOKEN: string;
	BOT_SECRET_TOKEN: string; // AppSec: Prevents unauthorized arbitrary webhook invocations
	DB: D1Database;
}

// Extend Grammy context to expose Cloudflare's ExecutionContext
type SuperContext = Context & { cfCtx: ExecutionContext };

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (!env.BOT_TOKEN) return new Response('Unauthorized', { status: 401 });

		const bot = new Bot<SuperContext>(env.BOT_TOKEN);

		// AppSec: Handle rate limits (HTTP 429) automatically to prevent drops
		bot.api.config.use(autoRetry());

		// Inject Cloudflare Context
		bot.use((botCtx, next) => {
			botCtx.cfCtx = ctx;
			return next();
		});

		// Middleware: Silently log all active members to D1 to maintain a queryable target list
		bot.on(['message', 'chat_member'], async (botCtx, next) => {
			const chatId = botCtx.chat?.id;
			const userId = botCtx.from?.id;

			if (chatId && userId && botCtx.chat?.type !== 'private') {
				// AppSec: Strict parameterization to mitigate SQLi vectors
				await env.DB.prepare(
					'INSERT OR IGNORE INTO members (chat_id, user_id) VALUES (?, ?)'
				)
					.bind(chatId, userId)
					.run()
					.catch((err) => console.error('DB Insert Error:', err)); // Non-blocking
			}
			return next();
		});

		// Command: /cleandeleted
		bot.command('cleandeleted', async (botCtx) => {
			if (botCtx.chat.type === 'private') {
				return botCtx.reply('❌ This command is restricted to groups/supergroups.');
			}

			// AppSec: Strict Authorization Check
			const chatAdmins = await botCtx.getChatAdministrators();
			const isAdmin = chatAdmins.some((admin) => admin.user.id === botCtx.from?.id);
			
			// Allow group anonymous bots or verified admins
			if (!isAdmin && botCtx.from?.id !== botCtx.chat.id && botCtx.from?.username !== 'GroupAnonymousBot') {
				return botCtx.reply('⛔ **Access Denied**: Administrator privileges required.');
			}

			const chatId = botCtx.chat.id;
			const statusMsg = await botCtx.reply('⏳ Starting ghost account cleanup. This is running in the background...');

			// Background the heavy processing to avoid Webhook timeout cascades
			botCtx.cfCtx.waitUntil((async () => {
				try {
					const result = await env.DB.prepare('SELECT user_id FROM members WHERE chat_id = ?')
						.bind(chatId)
						.all<{ user_id: number }>();

					if (!result.success || !result.results) throw new Error('Database retrieval failed');

					const users = result.results;
					let kickedCount = 0;
					let checkedCount = 0;

					for (const row of users) {
						try {
							const member = await botCtx.api.getChatMember(chatId, row.user_id);
							checkedCount++;

							// Logic Check: Telegram Bot API represents deleted accounts with the literal string 'Deleted Account' or empty.
							const isDeletedAccount = 
								member.user.first_name === 'Deleted Account' || 
								member.user.first_name === ''; 

							if (isDeletedAccount && !['left', 'kicked'].includes(member.status)) {
								// Action: Ban removes the user, unban allows them back theoretically (though ghosts cannot rejoin)
								await botCtx.api.banChatMember(chatId, row.user_id);
								await botCtx.api.unbanChatMember(chatId, row.user_id); 
								kickedCount++;
								
								await env.DB.prepare('DELETE FROM members WHERE chat_id = ? AND user_id = ?')
									.bind(chatId, row.user_id)
									.run();
							} else if (['left', 'kicked'].includes(member.status)) {
								// Prune DB of users who legitimately left
								await env.DB.prepare('DELETE FROM members WHERE chat_id = ? AND user_id = ?')
									.bind(chatId, row.user_id)
									.run();
							}
						} catch (error) {
							// Prune invalid/deleted IDs throwing 400 Bad Request
							if (error instanceof TelegramError && error.description.toLowerCase().includes('user not found')) {
								await env.DB.prepare('DELETE FROM members WHERE chat_id = ? AND user_id = ?')
									.bind(chatId, row.user_id)
									.run();
							}
						}

						// Rate Limiting Mitigation: Throttle API calls to prevent global bans
						if (checkedCount % 20 === 0) {
							await new Promise((resolve) => setTimeout(resolve, 1000));
						}
					}

					await botCtx.api.editMessageText(
						chatId, 
						statusMsg.message_id, 
						`✅ **Cleanup Complete**\n\n🔍 Checked: ${checkedCount}\n👻 Ghosts Purged: ${kickedCount}`,
						{ parse_mode: 'Markdown' }
					);

				} catch (error) {
					console.error('Background Cleanup Error:', error);
					await botCtx.api.editMessageText(chatId, statusMsg.message_id, '❌ A critical error occurred during the background cleanup task.');
				}
			})());
		});

		// AppSec: Bind strict Webhook Secret validation to drop malicious payloads
		const handleUpdate = webhookCallback(bot, 'cloudflare-fetch', {
			secretToken: env.BOT_SECRET_TOKEN,
		});

		return handleUpdate(request);
	},
} satisfies ExportedHandler<Env>;
