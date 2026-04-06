"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/feature/auth";
import { Button } from "@/shared/components/ui/button";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  signAndSubmitWithZkLogin,
  getCreatedObjectId,
  type ZkLoginSession,
} from "@/feature/auth/lib/zklogin-tx";
import type { ZkLoginSessionData } from "@/feature/auth/domain/type";
import { Copy, Check, ExternalLink, Loader2, AlertCircle } from "lucide-react";

const MEMWAL_PACKAGE_ID =
  process.env.NEXT_PUBLIC_MEMWAL_PACKAGE_ID ??
  "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6";

const MEMWAL_REGISTRY_ID =
  process.env.NEXT_PUBLIC_MEMWAL_REGISTRY_ID ??
  "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437";

type Step = "intro" | "generating" | "show-key" | "onchain" | "done";

function isZkLoginSession(session: unknown): session is ZkLoginSessionData {
  return (
    !!session &&
    typeof session === "object" &&
    "ephemeralKeyPair" in session &&
    "zkProof" in session &&
    !!(session as ZkLoginSessionData).zkProof
  );
}

export function SetupWizard() {
  const router = useRouter();
  const { suiAddress, session } = useAuth();

  const [step, setStep] = useState<Step>("intro");
  const [privateKeyHex, setPrivateKeyHex] = useState("");
  const [publicKeyHex, setPublicKeyHex] = useState("");
  const [accountId, setAccountId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [txStatus, setTxStatus] = useState("");
  const [error, setError] = useState("");

  const isZkLogin = isZkLoginSession(session);

  const generateKeypair = useCallback(async () => {
    setStep("generating");
    setError("");

    try {
      const keypair = new Ed25519Keypair();
      const privHex = Buffer.from(keypair.getSecretKey()).toString("hex");
      const pubHex = keypair.getPublicKey().toHex();

      setPrivateKeyHex(privHex);
      setPublicKeyHex(pubHex);
      setStep("show-key");
    } catch {
      setError("Failed to generate keypair. Please try again.");
      setStep("intro");
    }
  }, []);

  const executeOnchain = useCallback(async () => {
    if (!suiAddress || !isZkLogin || !session) return;
    setStep("onchain");
    setError("");

    const zkSession = session as ZkLoginSessionData;
    const signerSession: ZkLoginSession = {
      suiAddress,
      ephemeralKeyPair: zkSession.ephemeralKeyPair,
      zkProof: zkSession.zkProof!,
      maxEpoch: zkSession.maxEpoch,
    };

    const pubKeyBytes = Array.from(Buffer.from(publicKeyHex, "hex"));
    // Derive the Sui address for the delegate key
    const delegateKeypair = Ed25519Keypair.fromSecretKey(
      Buffer.from(privateKeyHex, "hex")
    );
    const delegateSuiAddress = delegateKeypair.toSuiAddress();

    try {
      // Check if MemWalAccount already exists
      setTxStatus("Checking for existing account...");
      let knownAccountId: string | null = null;

      try {
        const res = await fetch(
          `https://fullnode.testnet.sui.io:443`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "suix_getObject",
              params: [
                MEMWAL_REGISTRY_ID,
                { showContent: true },
              ],
            }),
          }
        );
        const data = await res.json();
        const fields = data?.result?.data?.content?.fields;
        const tableId = fields?.accounts?.fields?.id?.id;

        if (tableId) {
          const dynRes = await fetch(`https://fullnode.testnet.sui.io:443`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "suix_getDynamicFieldObject",
              params: [tableId, { type: "address", value: suiAddress }],
            }),
          });
          const dynData = await dynRes.json();
          const dynFields = dynData?.result?.data?.content?.fields;
          if (dynFields?.value) knownAccountId = dynFields.value as string;
        }
      } catch {
        // No account yet
      }

      if (knownAccountId) {
        // Account exists — just add delegate key
        setTxStatus("Account found. Adding delegate key...");
        const tx = new Transaction();
        tx.moveCall({
          target: `${MEMWAL_PACKAGE_ID}::account::add_delegate_key`,
          arguments: [
            tx.object(knownAccountId),
            tx.pure("vector<u8>", pubKeyBytes),
            tx.pure("address", delegateSuiAddress),
            tx.pure("string", "Noter"),
            tx.object("0x6"),
          ],
        });
        await signAndSubmitWithZkLogin(tx, signerSession);
        setAccountId(knownAccountId);
      } else {
        // Create account first
        setTxStatus("Creating MemWal account...");
        const tx1 = new Transaction();
        tx1.moveCall({
          target: `${MEMWAL_PACKAGE_ID}::account::create_account`,
          arguments: [
            tx1.object(MEMWAL_REGISTRY_ID),
            tx1.object("0x6"),
          ],
        });
        const createDigest = await signAndSubmitWithZkLogin(tx1, signerSession);

        // Get the created account ID
        const createdId = await getCreatedObjectId(createDigest, "MemWalAccount");
        knownAccountId = createdId;

        // Add delegate key
        setTxStatus("Adding delegate key...");
        const tx2 = new Transaction();
        tx2.moveCall({
          target: `${MEMWAL_PACKAGE_ID}::account::add_delegate_key`,
          arguments: [
            tx2.object(knownAccountId!),
            tx2.pure("vector<u8>", pubKeyBytes),
            tx2.pure("address", delegateSuiAddress),
            tx2.pure("string", "Noter"),
            tx2.object("0x6"),
          ],
        });
        await signAndSubmitWithZkLogin(tx2, signerSession);
        setAccountId(knownAccountId ?? "");
      }

      // Save to localStorage (same keys UserFloatPanel reads)
      localStorage.setItem("memwal_key", privateKeyHex);
      if (knownAccountId) {
        localStorage.setItem("memwal_account_id", knownAccountId);
      }

      setStep("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      setError(msg);
      setStep("show-key");
    }
  }, [suiAddress, session, isZkLogin, publicKeyHex, privateKeyHex]);

  const copyKey = useCallback(async () => {
    await navigator.clipboard.writeText(privateKeyHex);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [privateKeyHex]);

  // Wallet user — can't sign on-chain, redirect to playground
  if (!isZkLogin) {
    return (
      <div className="max-w-md mx-auto mt-16 space-y-4 text-center">
        <h2 className="text-2xl font-bold">Setup MemWal Access</h2>
        <p className="text-muted-foreground">
          You're signed in with a wallet. Create your delegate key and MemWal
          account at the playground dashboard, then paste your private key and
          account ID in the profile panel here.
        </p>
        <Button asChild>
          <a
            href="https://memwal.wal.app"
            target="_blank"
            rel="noopener noreferrer"
          >
            Go to Playground <ExternalLink className="ml-2 h-4 w-4" />
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto mt-16 space-y-6">
      {/* ── Intro ── */}
      {step === "intro" && (
        <div className="space-y-6 text-center">
          <div>
            <h2 className="text-2xl font-bold">Create Delegate Key</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              A delegate key lets noter access MemWal on your behalf — separate
              from your Google account.
            </p>
          </div>

          {/* Address + faucet */}
          <div className="rounded-lg border bg-muted/40 p-4 text-left space-y-2">
            <p className="text-xs text-muted-foreground font-medium">Your Sui address</p>
            <code className="block text-xs break-all">{suiAddress}</code>
            <a
              href={`https://faucet.testnet.sui.io/?address=${suiAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Fund from testnet faucet (needed for gas)
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>

          <Button onClick={generateKeypair} className="w-full">
            Generate Delegate Key
          </Button>
        </div>
      )}

      {/* ── Generating ── */}
      {step === "generating" && (
        <div className="flex flex-col items-center gap-4 py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Generating keypair...</p>
        </div>
      )}

      {/* ── Show Key ── */}
      {step === "show-key" && (
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-bold">Key Generated</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Save your private key now — it won't be shown again.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="rounded-lg border bg-muted/40 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Private key (keep secret)
              </span>
              <Button variant="ghost" size="sm" onClick={copyKey} className="h-7 px-2">
                {copied ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                <span className="ml-1 text-xs">{copied ? "Copied" : "Copy"}</span>
              </Button>
            </div>
            <code className="block text-xs break-all">{privateKeyHex}</code>
          </div>

          <label className="flex items-start gap-3 cursor-pointer text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5"
            />
            I have saved my private key. I understand it cannot be recovered.
          </label>

          <Button
            onClick={executeOnchain}
            disabled={!confirmed}
            className="w-full"
          >
            Register on-chain & continue →
          </Button>
        </div>
      )}

      {/* ── Onchain ── */}
      {step === "onchain" && (
        <div className="flex flex-col items-center gap-4 py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{txStatus}</p>
          <p className="text-xs text-muted-foreground/70">
            Signing with your zkLogin session...
          </p>
        </div>
      )}

      {/* ── Done ── */}
      {step === "done" && (
        <div className="space-y-4 text-center">
          <h2 className="text-xl font-bold">All set!</h2>
          <p className="text-sm text-muted-foreground">
            Your delegate key is registered on-chain.
          </p>
          {accountId && (
            <div className="rounded-lg border bg-muted/40 p-4 text-left space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                MemWal Account ID
              </p>
              <code className="block text-xs break-all">{accountId}</code>
            </div>
          )}
          <Button onClick={() => router.push("/")} className="w-full">
            Start Taking Notes →
          </Button>
        </div>
      )}
    </div>
  );
}
