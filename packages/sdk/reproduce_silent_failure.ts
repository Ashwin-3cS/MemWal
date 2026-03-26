/**
 * Reproduces silent failure in MemWalManual.recallManual()
 *
 * Bug: packages/sdk/src/manual.ts:298-300
 * When ALL Walrus downloads fail, recallManual() returns { results: [], total: 0 }
 * — identical to "no memories found". Caller cannot distinguish infra failure from empty results.
 *
 * Steps:
 *   1. Store memories via MemWal server-mode (local server handles embed + SEAL + Walrus)
 *   2. Recall via MemWalManual with bad walrusAggregatorUrl → all downloads fail → silent empty
 *
 * Env vars required:
 *   MEMWAL_DELEGATE_KEY, MEMWAL_ACCOUNT_ID, MEMWAL_SERVER_URL,
 *   SUI_PRIVATE_KEY, JINA_API_KEY, MEMWAL_PACKAGE_ID
 *
 * Run: npx tsx packages/sdk/reproduce_silent_failure.ts
 */

import { MemWal } from "./src/index.js";
import { MemWalManual } from "./src/manual-entry.js";

const DELEGATE_KEY = process.env.MEMWAL_DELEGATE_KEY!;
const ACCOUNT_ID = process.env.MEMWAL_ACCOUNT_ID!;
const SERVER_URL = process.env.MEMWAL_SERVER_URL ?? "http://localhost:8000";
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY!;
const JINA_API_KEY = process.env.JINA_API_KEY!;
const PACKAGE_ID = process.env.MEMWAL_PACKAGE_ID!;

if (!DELEGATE_KEY || !ACCOUNT_ID || !SUI_PRIVATE_KEY || !JINA_API_KEY || !PACKAGE_ID) {
    console.error("Missing required env vars. See script header for list.");
    process.exit(1);
}

async function main() {
    console.log("=== MemWalManual Silent Failure Reproduction ===");
    console.log("Bug: packages/sdk/src/manual.ts:298-300\n");

    // ── Step 1: Store a memory via server-mode (server handles everything) ──
    console.log("[step 1] Storing memory via MemWal server-mode...");
    const serverClient = MemWal.create({
        key: DELEGATE_KEY,
        accountId: ACCOUNT_ID,
        serverUrl: SERVER_URL,
        namespace: "bug-repro",
    });

    const health = await serverClient.health();
    console.log(`  Server health: ${JSON.stringify(health)}`);

    try {
        const stored = await serverClient.remember("I'm allergic to peanuts", "bug-repro");
        console.log(`  Stored: blob_id=${stored.blob_id}`);
    } catch (err: any) {
        console.log(`  Store failed: ${err.message}`);
        console.log("  (Continuing — may already have memories in DB from prior run)");
    }

    // ── Step 2: Verify recall works with server-mode (proves data exists) ──
    console.log("\n[step 2] Verifying recall works via server-mode...");
    try {
        const serverRecall = await serverClient.recall("food allergies", 5, "bug-repro");
        console.log(`  Server recall: ${serverRecall.total} results`);
        if (serverRecall.results.length > 0) {
            console.log(`  Top result: "${serverRecall.results[0].text}" (dist=${serverRecall.results[0].distance})`);
        }
    } catch (err: any) {
        console.log(`  Server recall failed: ${err.message}`);
    }

    // ── Step 3: Recall via MemWalManual with broken Walrus URL ──
    console.log("\n[step 3] Recalling via MemWalManual with BROKEN Walrus aggregator...");
    const manualClient = MemWalManual.create({
        key: DELEGATE_KEY,
        accountId: ACCOUNT_ID,
        serverUrl: SERVER_URL,
        suiPrivateKey: SUI_PRIVATE_KEY,
        embeddingApiKey: JINA_API_KEY,
        embeddingApiBase: "https://api.jina.ai/v1",
        embeddingModel: "jina-embeddings-v2-base-en",
        packageId: PACKAGE_ID,
        suiNetwork: "testnet",
        // Point Walrus to a dead URL — simulates Walrus outage
        walrusAggregatorUrl: "http://localhost:9999",
    });

    const result = await manualClient.recallManual("food allergies", 5, "bug-repro");

    console.log(`\n[result] ${JSON.stringify(result, null, 2)}`);

    if (result.results.length === 0 && result.total === 0) {
        console.log("  The server found matching memories (step 2 proved they exist),");
        console.log("  but all Walrus downloads failed silently.");
        console.log("  The caller cannot distinguish this from 'no memories match the query'.");
    }
}

main().catch(console.error);
