import { createHash, randomBytes } from "node:crypto";
import type { Program } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { beforeAll, describe, expect, it } from "vitest";
import type { CurvyPortal } from "../target/types/curvy_portal";

const RECOVERY_DOMAIN = Buffer.from("curvy-solana-recovery-v1");
const RECOVER_MSG_PREFIX = Buffer.from("curvy-solana-recover");

/** Derive the 32-byte recovery identifier from a SECP256k1 private key */
function deriveRecoveryIdentifier(privKey: Uint8Array): PublicKey {
  const compressedPubKey = secp256k1.getPublicKey(privKey, true); // 33 bytes
  const hash = createHash("sha256").update(RECOVERY_DOMAIN).update(compressedPubKey).digest();
  return new PublicKey(hash);
}

/** Build and sign a recovery message for a given vault and recipient */
function signRecoveryMessage(
  privKey: Uint8Array,
  vault: PublicKey,
  recipient: PublicKey,
): { sig: Buffer; recoveryId: number } {
  const msgHash = createHash("sha256")
    .update(RECOVER_MSG_PREFIX)
    .update(vault.toBuffer())
    .update(recipient.toBuffer())
    .digest();

  const sig = secp256k1.sign(msgHash, privKey, { prehash: false, format: "recovered" });
  const sigInstance = secp256k1.Signature.fromBytes(sig, "recovered");

  return {
    sig: Buffer.from(sigInstance.toBytes("compact")), // 64 bytes: r || s
    recoveryId: sigInstance.recovery!,
  };
}

const CONFIG_SEED = Buffer.from("config");
const PORTAL_SEED = Buffer.from("portal");
const PORTAL_META_SEED = Buffer.from("portal_meta");

describe("curvy-portal", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CurvyPortal as Program<CurvyPortal>;
  const authority = provider.wallet as anchor.Wallet;
  const operator = Keypair.generate();
  const recovery = Keypair.generate();

  // A sample owner hash (32 bytes, non-zero)
  const ownerHash = Buffer.alloc(32);
  ownerHash.writeUInt32BE(12345, 28);

  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let portalMetaPda: PublicKey;

  beforeAll(async () => {
    [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], program.programId);

    [vaultPda] = PublicKey.findProgramAddressSync(
      [PORTAL_SEED, ownerHash, recovery.publicKey.toBuffer()],
      program.programId,
    );

    [portalMetaPda] = PublicKey.findProgramAddressSync(
      [PORTAL_META_SEED, ownerHash, recovery.publicKey.toBuffer()],
      program.programId,
    );

    const sig = await provider.connection.requestAirdrop(operator.publicKey, 10 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);
  });

  describe("initialize", () => {
    it("initializes config", async () => {
      await program.methods
        .initialize(operator.publicKey)
        .accounts({ authority: authority.publicKey })
        .rpc();

      const config = await program.account.portalConfig.fetch(configPda);
      expect(config.authority.toBase58()).toBe(authority.publicKey.toBase58());
      expect(config.operator.toBase58()).toBe(operator.publicKey.toBase58());
      expect(config.destinationChainId.toNumber()).toBe(42161);
    });

    it("fails to initialize twice", async () => {
      await expect(
        program.methods
          .initialize(operator.publicKey)
          .accounts({ authority: authority.publicKey })
          .rpc(),
      ).rejects.toThrow();
    });
  });

  describe("update_config", () => {
    it("updates operator", async () => {
      const newOperator = Keypair.generate();

      await program.methods
        .updateConfig(newOperator.publicKey, null)
        .accounts({ authority: authority.publicKey })
        .rpc();

      let config = await program.account.portalConfig.fetch(configPda);
      expect(config.operator.toBase58()).toBe(newOperator.publicKey.toBase58());

      // Restore original operator
      await program.methods
        .updateConfig(operator.publicKey, null)
        .accounts({ authority: authority.publicKey })
        .rpc();

      config = await program.account.portalConfig.fetch(configPda);
      expect(config.operator.toBase58()).toBe(operator.publicKey.toBase58());
    });

    it("rejects non-authority", async () => {
      const impostor = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(impostor.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      await expect(
        program.methods
          .updateConfig(impostor.publicKey, null)
          .accounts({ authority: impostor.publicKey })
          .signers([impostor])
          .rpc(),
      ).rejects.toThrow(/UnauthorizedAuthority/);
    });
  });

  describe("create_and_bridge_sol", () => {
    const depositAmount = 2 * LAMPORTS_PER_SOL;

    beforeAll(async () => {
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: vaultPda,
          lamports: depositAmount,
        }),
      );
      await provider.sendAndConfirm(tx);

      const balance = await provider.connection.getBalance(vaultPda);
      expect(balance).toBe(depositAmount);
    });

    it("withdraws SOL from vault to operator", async () => {
      const operatorBalanceBefore = await provider.connection.getBalance(operator.publicKey);

      await program.methods
        .createAndBridgeSol(Array.from(ownerHash) as any)
        .accounts({
          operator: operator.publicKey,
          recovery: recovery.publicKey,
          destination: operator.publicKey,
        })
        .signers([operator])
        .rpc();

      const vaultBalance = await provider.connection.getBalance(vaultPda);
      expect(vaultBalance).toBe(0);

      const operatorBalanceAfter = await provider.connection.getBalance(operator.publicKey);
      expect(operatorBalanceAfter).toBeGreaterThan(operatorBalanceBefore);

      const portal = await program.account.portalAccount.fetch(portalMetaPda);
      expect(portal.isUsed).toBe(true);
      expect(Buffer.from(portal.ownerHash)).toEqual(ownerHash);
      expect(portal.recovery.toBase58()).toBe(recovery.publicKey.toBase58());
      expect(portal.amountWithdrawn.toNumber()).toBe(depositAmount);
      expect(portal.currencyMint.toBase58()).toBe(PublicKey.default.toBase58());
    });

    it("fails on second bridge attempt (single-use)", async () => {
      await expect(
        program.methods
          .createAndBridgeSol(Array.from(ownerHash) as any)
          .accounts({
            operator: operator.publicKey,
            recovery: recovery.publicKey,
            destination: operator.publicKey,
          })
          .signers([operator])
          .rpc(),
      ).rejects.toThrow();
    });

    it("rejects non-operator", async () => {
      const impostor = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(impostor.publicKey, LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);

      const otherOwnerHash = Buffer.alloc(32);
      otherOwnerHash.writeUInt32BE(99999, 28);

      await expect(
        program.methods
          .createAndBridgeSol(Array.from(otherOwnerHash) as any)
          .accounts({
            operator: impostor.publicKey,
            recovery: recovery.publicKey,
            destination: impostor.publicKey,
          })
          .signers([impostor])
          .rpc(),
      ).rejects.toThrow(/UnauthorizedOperator/);
    });
  });

  describe("create_and_bridge_spl", () => {
    const splOwnerHash = Buffer.alloc(32);
    splOwnerHash.writeUInt32BE(67890, 28);

    let mint: PublicKey;
    let splVaultPda: PublicKey;
    let splPortalMetaPda: PublicKey;
    let vaultAta: PublicKey;
    let operatorAta: PublicKey;
    const depositAmount = 1_000_000_000;

    beforeAll(async () => {
      [splVaultPda] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED, splOwnerHash, recovery.publicKey.toBuffer()],
        program.programId,
      );
      [splPortalMetaPda] = PublicKey.findProgramAddressSync(
        [PORTAL_META_SEED, splOwnerHash, recovery.publicKey.toBuffer()],
        program.programId,
      );

      mint = await createMint(provider.connection, authority.payer, authority.publicKey, null, 9);

      const vaultAtaAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        mint,
        splVaultPda,
        true,
      );
      vaultAta = vaultAtaAccount.address;

      await mintTo(provider.connection, authority.payer, mint, vaultAta, authority.publicKey, depositAmount);

      const operatorAtaAccount = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        mint,
        operator.publicKey,
      );
      operatorAta = operatorAtaAccount.address;
    });

    it("withdraws SPL tokens from vault to operator", async () => {
      await program.methods
        .createAndBridgeSpl(Array.from(splOwnerHash) as any)
        .accounts({
          operator: operator.publicKey,
          destinationTokenAccount: operatorAta,
          mint: mint,
          recovery: recovery.publicKey,
        })
        .signers([operator])
        .rpc();

      const operatorTokenAccount = await getAccount(provider.connection, operatorAta);
      expect(Number(operatorTokenAccount.amount)).toBe(depositAmount);

      const vaultTokenAccount = await getAccount(provider.connection, vaultAta);
      expect(Number(vaultTokenAccount.amount)).toBe(0);

      const portal = await program.account.portalAccount.fetch(splPortalMetaPda);
      expect(portal.isUsed).toBe(true);
      expect(portal.amountWithdrawn.toNumber()).toBe(depositAmount);
      expect(portal.currencyMint.toBase58()).toBe(mint.toBase58());
    });
  });

  describe("recover_sol", () => {
    const recoverOwnerHash = Buffer.alloc(32);
    recoverOwnerHash.writeUInt32BE(11111, 28);

    const secpPrivKey = randomBytes(32);
    const recoveryIdentifier = deriveRecoveryIdentifier(secpPrivKey);

    let recoverVaultPda: PublicKey;
    const depositAmount = LAMPORTS_PER_SOL;

    beforeAll(async () => {
      [recoverVaultPda] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED, recoverOwnerHash, recoveryIdentifier.toBuffer()],
        program.programId,
      );

      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: recoverVaultPda,
          lamports: depositAmount,
        }),
      );
      await provider.sendAndConfirm(tx);
    });

    it("recovers SOL from uninitialized portal", async () => {
      const recipient = Keypair.generate();

      const { sig: secpSig, recoveryId: recId } = signRecoveryMessage(
        secpPrivKey,
        recoverVaultPda,
        recipient.publicKey,
      );

      await program.methods
        .recoverSol(Array.from(recoverOwnerHash) as any, Array.from(secpSig) as any, recId)
        .accounts({
          payer: authority.publicKey,
          recoveryIdentifier: recoveryIdentifier,
          recipient: recipient.publicKey,
        })
        .rpc();

      const recipientBalance = await provider.connection.getBalance(recipient.publicKey);
      expect(recipientBalance).toBe(depositAmount);

      const vaultBalance = await provider.connection.getBalance(recoverVaultPda);
      expect(vaultBalance).toBe(0);
    });

    it("rejects wrong recovery signer", async () => {
      const wrongOwnerHash = Buffer.alloc(32);
      wrongOwnerHash.writeUInt32BE(33333, 28);

      const [testVault] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED, wrongOwnerHash, recoveryIdentifier.toBuffer()],
        program.programId,
      );

      const fundTx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: testVault,
          lamports: LAMPORTS_PER_SOL / 10,
        }),
      );
      await provider.sendAndConfirm(fundTx);

      const wrongPrivKey = randomBytes(32);
      const { sig: secpSig, recoveryId: recId } = signRecoveryMessage(
        wrongPrivKey,
        testVault,
        authority.publicKey,
      );

      await expect(
        program.methods
          .recoverSol(Array.from(wrongOwnerHash) as any, Array.from(secpSig) as any, recId)
          .accounts({
            payer: authority.publicKey,
            recoveryIdentifier: recoveryIdentifier,
            recipient: authority.publicKey,
          })
          .rpc(),
      ).rejects.toThrow();
    });
  });

  describe("recover_spl", () => {
    const recoverSplOwnerHash = Buffer.alloc(32);
    recoverSplOwnerHash.writeUInt32BE(22222, 28);

    const splSecpPrivKey = randomBytes(32);
    const splRecoveryIdentifier = deriveRecoveryIdentifier(splSecpPrivKey);

    let recoverSplVaultPda: PublicKey;
    let splMint: PublicKey;
    let splVaultAta: PublicKey;
    const depositAmount = 500_000_000;

    beforeAll(async () => {
      [recoverSplVaultPda] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED, recoverSplOwnerHash, splRecoveryIdentifier.toBuffer()],
        program.programId,
      );

      splMint = await createMint(provider.connection, authority.payer, authority.publicKey, null, 9);

      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        splMint,
        recoverSplVaultPda,
        true,
      );
      splVaultAta = ata.address;

      await mintTo(provider.connection, authority.payer, splMint, splVaultAta, authority.publicKey, depositAmount);
    });

    it("recovers SPL tokens and closes ATA", async () => {
      const recipientKp = Keypair.generate();

      const recipientAta = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        splMint,
        recipientKp.publicKey,
      );

      const { sig: secpSig, recoveryId: recId } = signRecoveryMessage(
        splSecpPrivKey,
        recoverSplVaultPda,
        recipientKp.publicKey,
      );

      await program.methods
        .recoverSpl(Array.from(recoverSplOwnerHash) as any, Array.from(secpSig) as any, recId)
        .accounts({
          payer: authority.publicKey,
          recoveryIdentifier: splRecoveryIdentifier,
          recipientTokenAccount: recipientAta.address,
          recipient: recipientKp.publicKey,
          mint: splMint,
        })
        .rpc();

      const recipientAccount = await getAccount(provider.connection, recipientAta.address);
      expect(Number(recipientAccount.amount)).toBe(depositAmount);

      await expect(getAccount(provider.connection, splVaultAta)).rejects.toThrow();
    });
  });
});
