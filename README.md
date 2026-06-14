# Super Robot

A highly scalable, serverless Telegram bot built on Cloudflare Workers and D1 Database to automatically track and purge "Deleted Accounts" from supergroups.

## Architecture & Security Posture

*   **Serverless Execution:** Runs entirely on Cloudflare Workers via `src/index.ts`[cite: 3].
*   **Stateful Tracking:** Uses Cloudflare D1 to continuously track active chat members.
*   **AppSec Hardened:** 
    *   **SQLi Prevention:** Strict parameterized database queries.
    *   **Arbitrary Execution Mitigation:** Webhook invocation is cryptographically verified via `BOT_SECRET_TOKEN`.
    *   **RBAC Authorization:** Strict administrative checks prevent unauthorized users from triggering massive job executions.
*   **Performance Optimization:** Decouples heavy API operations from the immediate webhook lifecycle using `ctx.waitUntil`. Employs database pagination (`LIMIT`/`OFFSET`) and Promise batching (`Promise.allSettled`) to manage CPU/Wall-time and memory limits safely.

## Project Structure

*   `src/index.ts` - Main entry point containing webhook listener and core bot logic[cite: 3].
*   `wrangler.jsonc` - Cloudflare infrastructure-as-code configuration and database bindings[cite: 3].
*   `tsconfig.json` - Strict TypeScript configurations[cite: 3].
*   `package.json` - Project dependencies[cite: 3].
*   `.prettierrc` - Standardized code formatting definitions[cite: 3].
*   `AGENTS.md` - Agent directives and specifications[cite: 3].

## Deployment Instructions

### 1. Database Initialization
Provision the D1 database to store member states securely:

```bash
npx wrangler d1 create super-robot
npx wrangler d1 execute super-robot --command "CREATE TABLE IF NOT EXISTS members (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (chat_id, user_id));" --remote
```
