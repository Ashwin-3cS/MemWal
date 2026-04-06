/**
 * ZKLOGIN TRANSACTION SIGNING
 * Sign and submit Sui PTBs using a zkLogin session (no dapp-kit required)
 */

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { assembleZkLoginSignature } from "./zklogin-client";
import type { ZkProofData } from "@/shared/db/type";
import type { SuiObjectChange } from "@mysten/sui/jsonRpc";
import { ZKLOGIN_CONFIG } from "../constant";

const FULLNODE_URL =
  ZKLOGIN_CONFIG.network === "testnet"
    ? "https://fullnode.testnet.sui.io:443"
    : "https://fullnode.mainnet.sui.io:443";

function createClient() {
  return new SuiJsonRpcClient({ url: FULLNODE_URL });
}

export type ZkLoginSession = {
  suiAddress: string;
  ephemeralKeyPair: { privateKey: string; publicKey: string };
  zkProof: ZkProofData;
  maxEpoch: number;
};

/**
 * Sign a Transaction with zkLogin session data and submit to the network.
 * Returns the transaction digest on success.
 */
export async function signAndSubmitWithZkLogin(
  tx: Transaction,
  session: ZkLoginSession
): Promise<string> {
  const client = new SuiClient({ url: FULLNODE_URL });

  tx.setSenderIfNotSet(session.suiAddress);

  // Build — SuiClient resolves gas coins and object versions
  const txBytes = await tx.build({ client });

  // Sign with ephemeral keypair
  const ephemeralKeypair = Ed25519Keypair.fromSecretKey(
    session.ephemeralKeyPair.privateKey
  );
  const { signature: ephemeralSig } =
    await ephemeralKeypair.signTransaction(txBytes);

  // Assemble zkLogin signature
  const zkLoginSig = assembleZkLoginSignature({
    userSignature: ephemeralSig,
    zkProof: session.zkProof,
    ephemeralPublicKey: session.ephemeralKeyPair.publicKey,
    maxEpoch: session.maxEpoch,
  });

  // Execute
  const result = await client.executeTransactionBlock({
    transactionBlock: txBytes,
    signature: zkLoginSig,
    options: { showEffects: true, showObjectChanges: true },
    requestType: "WaitForLocalExecution",
  });

  if (result.effects?.status?.status === "failure") {
    throw new Error(
      `Transaction failed: ${result.effects.status.error ?? "unknown error"}`
    );
  }

  return result.digest;
}

/**
 * Get created object ID of a given Move type from a transaction result.
 * Used to find the MemWalAccount object ID after create_account.
 */
export async function getCreatedObjectId(
  digest: string,
  typeFragment: string
): Promise<string | null> {
  const client = new SuiClient({ url: FULLNODE_URL });
  const tx = await client.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });

  const created = tx.objectChanges?.find(
    (c) =>
      c.type === "created" &&
      "objectType" in c &&
      c.objectType.includes(typeFragment)
  );

  return created && "objectId" in created ? created.objectId : null;
}
