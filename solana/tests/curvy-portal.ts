import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { CurvyPortal } from "../target/types/curvy_portal";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createTransferInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import "dotenv/config";
import axios from "axios";
import { keccak_256 } from "@noble/hashes/sha3";
import * as fs from "fs";
import * as path from "path";

describe("curvy-portal", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const admin = provider.wallet as anchor.Wallet;

  const walletFundingKeypair = (): Keypair => {
    const w = provider.wallet as anchor.Wallet & { payer?: Keypair };
    if (!w.payer) {
      throw new Error("expected Anchor NodeWallet with .payer");
    }
    return w.payer;
  };

  const connection = provider.connection;

  const program = anchor.workspace.curvyPortal as Program<CurvyPortal>;

  const CONFIG_SEED = Buffer.from("config");
  const configPda = () =>
    PublicKey.findProgramAddressSync([CONFIG_SEED], program.programId)[0];

  const PORTAL_SEED = Buffer.from("portal");

  const sharedStealthOwnerHash = (): number[] => {
    const h = new Array<number>(32).fill(0);
    h[0] = 1;
    return h;
  };

  let sharedRecoverySolKeypair: Keypair | null = null;

  let sharedRecoverySplKeypair: Keypair | null = null;
  let sharedSplMint: PublicKey | null = null;
  let sharedSplOperator: Keypair | null = null;

  const loadKeypairFromEnv = (envVar: string): Keypair | undefined => {
    if (!envVar) return undefined;
    try {
      const arr = JSON.parse(envVar);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch (e) {
      throw new Error("<USER>_SECRET_KEY must be a JSON array of numbers");
    }
  };

  const user1 = loadKeypairFromEnv(process.env.USER1_SECRET_KEY || "");
  const user2 = loadKeypairFromEnv(process.env.USER2_SECRET_KEY || "");
  const user3 = loadKeypairFromEnv(process.env.USER3_SECRET_KEY || "");
  const user4 = loadKeypairFromEnv(process.env.USER4_SECRET_KEY || "");

  before(async () => {
    console.log("Admin public key", admin.publicKey.toBase58());
    if (user1) {
      console.log("User1 public key", user1.publicKey.toBase58());
    }
    if (user2) {
      console.log("User2 public key", user2.publicKey.toBase58());
    }
    if (user3) {
      console.log("User3 public key", user3.publicKey.toBase58());
    }
    if (user4) {
      console.log("User4 public key", user4.publicKey.toBase58());
    }
    if (user1) {
      const airdropSig = await connection.requestAirdrop(
        user1.publicKey,
        100 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig, "confirmed");
    }
    if (user2) {
      const airdropSig = await connection.requestAirdrop(
        user2.publicKey,
        100 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig, "confirmed");
    }
    if (user3) {
      const airdropSig = await connection.requestAirdrop(
        user3.publicKey,
        100 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig, "confirmed");
    }
    if (user4) {
      const airdropSig = await connection.requestAirdrop(
        user4.publicKey,
        100 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSig, "confirmed");
    }
  });

  describe("initialize", () => {
    it("creates portal config and sets operator + destination chain", async () => {
      const operator = user1 ?? Keypair.generate();

      await program.methods
        .initialize(operator.publicKey)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();

      const cfg = await program.account.portalConfig.fetch(configPda());
      expect(cfg.authority.toBase58()).to.equal(admin.publicKey.toBase58());
      expect(cfg.operator.toBase58()).to.equal(operator.publicKey.toBase58());
      expect(cfg.paused).to.equal(false);
      expect(cfg.destinationChainId.toNumber()).to.equal(42161);
    });

    it("fails on second initialize (config PDA already exists)", async () => {
      const operator = Keypair.generate();

      try {
        await program.methods
          .initialize(operator.publicKey)
          .accounts({
            authority: admin.publicKey,
          })
          .rpc();
        expect.fail("expected second initialize to fail");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const logs = (e.logs ?? []).join("\n");
        expect(
          msg.includes("already in use") ||
          logs.includes("already in use") ||
          msg.includes("AccountDiscriminatorMismatch") ||
          msg.includes("custom program error")
        ).to.be.true;
      }
    });
  });

  describe("updateConfig", () => {
    const airdrop = async (kp: Keypair) => {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    };

    it("updates operator when authority signs", async () => {
      const newOperator = Keypair.generate();

      await program.methods
        .updateConfig(newOperator.publicKey, null)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();

      const cfg = await program.account.portalConfig.fetch(configPda());
      expect(cfg.operator.toBase58()).to.equal(newOperator.publicKey.toBase58());
      expect(cfg.authority.toBase58()).to.equal(admin.publicKey.toBase58());
    });

    it("succeeds with no-op when both options are null", async () => {
      const before = await program.account.portalConfig.fetch(configPda());

      await program.methods
        .updateConfig(null, null)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();

      const after = await program.account.portalConfig.fetch(configPda());
      expect(after.operator.toBase58()).to.equal(before.operator.toBase58());
      expect(after.authority.toBase58()).to.equal(before.authority.toBase58());
    });

    it("transfers authority and new authority can update operator", async () => {
      const newAuthority = Keypair.generate();
      await airdrop(newAuthority);

      await program.methods
        .updateConfig(null, newAuthority.publicKey)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();

      let cfg = await program.account.portalConfig.fetch(configPda());
      expect(cfg.authority.toBase58()).to.equal(newAuthority.publicKey.toBase58());

      const nextOperator = Keypair.generate();
      await program.methods
        .updateConfig(nextOperator.publicKey, null)
        .accounts({
          authority: newAuthority.publicKey,
        })
        .signers([newAuthority])
        .rpc();

      cfg = await program.account.portalConfig.fetch(configPda());
      expect(cfg.operator.toBase58()).to.equal(nextOperator.publicKey.toBase58());

      await program.methods
        .updateConfig(null, admin.publicKey)
        .accounts({
          authority: newAuthority.publicKey,
        })
        .signers([newAuthority])
        .rpc();

      cfg = await program.account.portalConfig.fetch(configPda());
      expect(cfg.authority.toBase58()).to.equal(admin.publicKey.toBase58());
    });

    it("fails when signer is not the stored authority", async () => {
      const attacker = Keypair.generate();
      await airdrop(attacker);
      const decoyOperator = Keypair.generate();

      try {
        await program.methods
          .updateConfig(decoyOperator.publicKey, null)
          .accounts({
            authority: attacker.publicKey,
          })
          .signers([attacker])
          .rpc();
        expect.fail("expected unauthorized update to fail");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const code = e.error?.errorCode?.code;
        expect(
          msg.includes("UnauthorizedAuthority") ||
          msg.includes("Unauthorized") ||
          code === "UnauthorizedAuthority" ||
          code === 6001
        ).to.be.true;
      }
    });
  });

  describe("pause", () => {
    const airdrop = async (kp: Keypair) => {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    };

    it("sets paused to true", async () => {
      await program.methods
        .pause(true)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();

      const cfg = await program.account.portalConfig.fetch(configPda());
      expect(cfg.paused).to.equal(true);
    });

    it("sets paused to false (unpause)", async () => {
      await program.methods
        .pause(false)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();

      const cfg = await program.account.portalConfig.fetch(configPda());
      expect(cfg.paused).to.equal(false);
    });

    it("fails when signer is not the stored authority", async () => {
      const attacker = Keypair.generate();
      await airdrop(attacker);

      try {
        await program.methods
          .pause(true)
          .accounts({
            authority: attacker.publicKey,
          })
          .signers([attacker])
          .rpc();
        expect.fail("expected unauthorized pause to fail");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const code = e.error?.errorCode?.code;
        expect(
          msg.includes("UnauthorizedAuthority") ||
          msg.includes("Unauthorized") ||
          code === "UnauthorizedAuthority" ||
          code === 6001
        ).to.be.true;
      }
    });
  });

  describe("createStealthSol", () => {
    const airdrop = async (kp: Keypair) => {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    };

    let operator: Keypair;

    before(async () => {
      operator = Keypair.generate();
      await airdrop(operator);
      await program.methods
        .updateConfig(operator.publicKey, null)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();
    });

    it("succeeds with valid owner hash and recovery", async () => {
      sharedRecoverySolKeypair = Keypair.generate();
      await airdrop(sharedRecoverySolKeypair);

      await program.methods
        .createStealthSol(sharedStealthOwnerHash())
        .accounts({
          operator: operator.publicKey,
          recovery: sharedRecoverySolKeypair.publicKey,
        })
        .signers([operator])
        .rpc();
    });

    it("fails when signer is not the configured operator", async () => {
      const attacker = Keypair.generate();
      await airdrop(attacker);
      const recovery = Keypair.generate();

      try {
        await program.methods
          .createStealthSol(sharedStealthOwnerHash())
          .accounts({
            operator: attacker.publicKey,
            recovery: recovery.publicKey,
          })
          .signers([attacker])
          .rpc();
        expect.fail("expected non-operator to fail");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const code = e.error?.errorCode?.code;
        expect(
          msg.includes("UnauthorizedOperator") ||
          msg.includes("Unauthorized") ||
          code === "UnauthorizedOperator" ||
          code === 6000
        ).to.be.true;
      }
    });

    it("fails when owner hash is all zero", async () => {
      const recovery = Keypair.generate();
      const zeroHash = new Array<number>(32).fill(0);

      try {
        await program.methods
          .createStealthSol(zeroHash)
          .accounts({
            operator: operator.publicKey,
            recovery: recovery.publicKey,
          })
          .signers([operator])
          .rpc();
        expect.fail("expected zero owner hash to fail");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const code = e.error?.errorCode?.code;
        expect(
          msg.includes("InvalidOwnerHash") ||
          code === "InvalidOwnerHash" ||
          code === 6005
        ).to.be.true;
      }
    });

    it("fails when protocol is paused", async () => {
      await program.methods
        .pause(true)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();

      const recovery = Keypair.generate();

      try {
        await program.methods
          .createStealthSol(sharedStealthOwnerHash())
          .accounts({
            operator: operator.publicKey,
            recovery: recovery.publicKey,
          })
          .signers([operator])
          .rpc();
        expect.fail("expected create when paused to fail");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const code = e.error?.errorCode?.code;
        expect(
          msg.includes("Paused") || code === "Paused" || code === 6008
        ).to.be.true;
      }

      await program.methods
        .pause(false)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();
    });
  });

  describe("createStealthSplAta", () => {
    const airdrop = async (kp: Keypair) => {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    };

    let operator: Keypair;
    let mint: PublicKey;

    before(async () => {
      operator = Keypair.generate();
      await airdrop(operator);
      await program.methods
        .updateConfig(operator.publicKey, null)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();
      mint = await createMint(
        connection,
        operator,
        operator.publicKey,
        null,
        9
      );
      sharedSplMint = mint;
      sharedSplOperator = operator;
    });

    it("creates vault ATA for mint and matches vault PDA authority", async () => {
      sharedRecoverySplKeypair = Keypair.generate();
      await airdrop(sharedRecoverySplKeypair);

      await program.methods
        .createStealthSplAta(sharedStealthOwnerHash())
        .accounts({
          operator: operator.publicKey,
          recovery: sharedRecoverySplKeypair.publicKey,
          mint,
        })
        .signers([operator])
        .rpc();

      const ownerBuf = Buffer.from(sharedStealthOwnerHash());
      const [vault] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED, ownerBuf, sharedRecoverySplKeypair.publicKey.toBuffer()],
        program.programId
      );

      const ata = getAssociatedTokenAddressSync(
        mint,
        vault,
        true
      );
      const tokenAcc = await getAccount(connection, ata);
      expect(tokenAcc.mint.toBase58()).to.equal(mint.toBase58());
      expect(tokenAcc.owner.toBase58()).to.equal(vault.toBase58());
    });

    it("fails when signer is not the configured operator", async () => {
      const attacker = Keypair.generate();
      await airdrop(attacker);
      const recovery = Keypair.generate();

      try {
        await program.methods
          .createStealthSplAta(sharedStealthOwnerHash())
          .accounts({
            operator: attacker.publicKey,
            recovery: recovery.publicKey,
            mint,
          })
          .signers([attacker])
          .rpc();
        expect.fail("expected non-operator to fail");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const code = e.error?.errorCode?.code;
        expect(
          msg.includes("UnauthorizedOperator") ||
          msg.includes("Unauthorized") ||
          code === "UnauthorizedOperator" ||
          code === 6000
        ).to.be.true;
      }
    });

    it("fails when owner hash is all zero", async () => {
      const recovery = Keypair.generate();
      const zeroHash = new Array<number>(32).fill(0);

      try {
        await program.methods
          .createStealthSplAta(zeroHash)
          .accounts({
            operator: operator.publicKey,
            recovery: recovery.publicKey,
            mint,
          })
          .signers([operator])
          .rpc();
        expect.fail("expected zero owner hash to fail");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const code = e.error?.errorCode?.code;
        expect(
          msg.includes("InvalidOwnerHash") ||
          code === "InvalidOwnerHash" ||
          code === 6005
        ).to.be.true;
      }
    });

    it("fails when protocol is paused", async () => {
      await program.methods
        .pause(true)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();

      const recovery = Keypair.generate();

      try {
        await program.methods
          .createStealthSplAta(sharedStealthOwnerHash())
          .accounts({
            operator: operator.publicKey,
            recovery: recovery.publicKey,
            mint,
          })
          .signers([operator])
          .rpc();
        expect.fail("expected create when paused to fail");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const code = e.error?.errorCode?.code;
        expect(
          msg.includes("Paused") || code === "Paused" || code === 6008
        ).to.be.true;
      }

      await program.methods
        .pause(false)
        .accounts({
          authority: admin.publicKey,
        })
        .rpc();
    });
  });

  describe("recoverSol", () => {
    const airdrop = async (kp: Keypair) => {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    };

    it("withdraws SOL to recipient (same owner_hash + payer as create_stealth_sol)", async () => {
      if (!sharedRecoverySolKeypair) {
        throw new Error("expected sharedRecoverySolKeypair from createStealthSol");
      }
      const payer = sharedRecoverySolKeypair;
      const ownerHash = sharedStealthOwnerHash();
      const ownerBuf = Buffer.from(ownerHash);
      const [vault] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED, ownerBuf, payer.publicKey.toBuffer()],
        program.programId
      );

      const fundLamports = LAMPORTS_PER_SOL;
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: admin.publicKey,
          toPubkey: vault,
          lamports: fundLamports,
        })
      );
      await provider.sendAndConfirm(tx);

      const recipient = Keypair.generate();
      await airdrop(recipient);
      const beforeBal = await connection.getBalance(recipient.publicKey);

      await program.methods
        .recoverSol(ownerHash)
        .accounts({
          payer: payer.publicKey,
          recipient: recipient.publicKey,
        })
        .signers([payer])
        .rpc();

      const afterBal = await connection.getBalance(recipient.publicKey);
      expect(afterBal).to.be.greaterThan(beforeBal);
    });
  });

  describe("recoverSpl", () => {
    const airdrop = async (kp: Keypair) => {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    };

    it("withdraws SPL to recipient (same owner_hash + payer as create_stealth_spl_ata)", async () => {
      if (!sharedRecoverySplKeypair || !sharedSplMint || !sharedSplOperator) {
        throw new Error(
          "expected shared SPL fixture from createStealthSplAta first test"
        );
      }
      const payer = sharedRecoverySplKeypair;
      const mint = sharedSplMint;
      const operator = sharedSplOperator;

      const ownerHash = sharedStealthOwnerHash();
      const ownerBuf = Buffer.from(ownerHash);
      const [vault] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED, ownerBuf, payer.publicKey.toBuffer()],
        program.programId
      );
      const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);

      try {
        await getAccount(connection, vaultAta);
      } catch {
        await program.methods
          .createStealthSplAta(ownerHash)
          .accounts({
            operator: operator.publicKey,
            recovery: payer.publicKey,
            mint,
          })
          .signers([operator])
          .rpc();
      }

      const amount = BigInt(500_000);
      await mintTo(
        connection,
        operator,
        mint,
        vaultAta,
        operator,
        amount
      );

      const recipient = Keypair.generate();
      await airdrop(recipient);
      const recipientAtaInfo = await getOrCreateAssociatedTokenAccount(
        connection,
        walletFundingKeypair(),
        mint,
        recipient.publicKey,
        false,
        "confirmed",
        undefined,
        TOKEN_PROGRAM_ID
      );

      await program.methods
        .recoverSpl(ownerHash)
        .accountsPartial({
          payer: payer.publicKey,
          recipient: recipient.publicKey,
          mint,
          vaultTokenAccount: vaultAta,
          recipientTokenAccount: recipientAtaInfo.address,
        })
        .signers([payer])
        .rpc();

      const recipientAcc = await getAccount(
        connection,
        recipientAtaInfo.address
      );
      expect(Number(recipientAcc.amount)).to.equal(500_000);
    });

    it("create_stealth_spl_ata init_if_needed recreates vault ATA after recover closed it", async () => {
      if (!sharedRecoverySplKeypair || !sharedSplMint || !sharedSplOperator) {
        throw new Error(
          "expected shared SPL fixture from createStealthSplAta first test"
        );
      }
      const payer = sharedRecoverySplKeypair;
      const mint = sharedSplMint;
      const operator = sharedSplOperator;
      const ownerHash = sharedStealthOwnerHash();
      const ownerBuf = Buffer.from(ownerHash);
      const [vault] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED, ownerBuf, payer.publicKey.toBuffer()],
        program.programId
      );
      const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);

      await program.methods
        .createStealthSplAta(ownerHash)
        .accounts({
          operator: operator.publicKey,
          recovery: payer.publicKey,
          mint,
        })
        .signers([operator])
        .rpc();

      const recreated = await getAccount(connection, vaultAta);
      expect(recreated.mint.toBase58()).to.equal(mint.toBase58());
      expect(recreated.owner.toBase58()).to.equal(vault.toBase58());
    });
  });

  // --------------------- LIFI HELPERS ---------------------
  const LIFI_API = "https://li.quest/v1";
  const SOLANA_CHAIN_ID = 1151111081099710 as const;
  const ARBITRUM_CHAIN_ID = 42161 as const;
  const LIFI_BRIDGE_ACROSS = "across";
  const LIFI_BRIDGE_RELAY = "relay";
  const LIFI_BRIDGE_ECO = "eco";


  function lifiManualRelayOnlyFilters(): Record<string, string> {
    return {
      allowBridges: LIFI_BRIDGE_RELAY,
      preferBridges: LIFI_BRIDGE_RELAY,
      denyBridges: `${LIFI_BRIDGE_ACROSS},${LIFI_BRIDGE_ECO}`,
    };
  }

  const USDC_SOLANA = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const WSOL_MINT_ADDRESS = "So11111111111111111111111111111111111111112";
  const USDC_ARBITRUM_EVM ="0xaf88d065e77c8cc2239327c5edb3a432268e5831";
  const WSOL_ARBITRUM_EVM = "0xb74da9fe2f96b9e0a5f4a3cf0b92dd2bec617124";
  const WETH_ARBITRUM_EVM = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";

  const ACROSS_V4_PROGRAM_ID = new PublicKey("DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru");

  const [ACROSS_STATE] = PublicKey.findProgramAddressSync(
    [Buffer.from("state"), Buffer.from(new BN(0).toArray("le", 8))],
    ACROSS_V4_PROGRAM_ID
  );

  const [ACROSS_EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    ACROSS_V4_PROGRAM_ID
  );

  function serializeDepositSeedData(args: {
    depositor: PublicKey;
    recipient: PublicKey;
    inputToken: PublicKey;
    outputToken: PublicKey;
    inputAmount: bigint;
    outputAmount: number[]; 
    destinationChainId: number;
    exclusiveRelayer: PublicKey;
    quoteTimestamp: number; 
    fillDeadline: number; 
    exclusivityParameter: number; 
    message: Buffer; 
  }): Buffer {
    const messageLen = args.message.length;
    const buf = Buffer.alloc(224 + messageLen);

    let offset = 0;
    args.depositor.toBuffer().copy(buf, offset); offset += 32;
    args.recipient.toBuffer().copy(buf, offset); offset += 32;
    args.inputToken.toBuffer().copy(buf, offset); offset += 32;
    args.outputToken.toBuffer().copy(buf, offset); offset += 32;

    buf.writeBigUInt64LE(args.inputAmount, offset); offset += 8;
    Buffer.from(args.outputAmount).copy(buf, offset); offset += 32;
    buf.writeBigUInt64LE(BigInt(args.destinationChainId), offset); offset += 8;
    args.exclusiveRelayer.toBuffer().copy(buf, offset); offset += 32;

    buf.writeUInt32LE(args.quoteTimestamp >>> 0, offset); offset += 4;
    buf.writeUInt32LE(args.fillDeadline >>> 0, offset); offset += 4;
    buf.writeUInt32LE(args.exclusivityParameter >>> 0, offset); offset += 4;

    buf.writeUInt32LE(messageLen >>> 0, offset); offset += 4;
    args.message.copy(buf, offset);
    return buf;
  }

  function acrossDelegateFromDepositSeedData(args: {
    depositor: PublicKey;
    recipient: PublicKey;
    inputToken: PublicKey;
    outputToken: PublicKey;
    inputAmount: bigint;
    outputAmount: number[]; 
    destinationChainId: number; 
    exclusiveRelayer: PublicKey;
    quoteTimestamp: number; 
    fillDeadline: number; 
    exclusivityParameter: number; 
    message: Buffer; 
  }): PublicKey {
    const seedDataBytes = serializeDepositSeedData(args as any);
    const delegateSeedHash = keccak_256(seedDataBytes); 
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("delegate"), Buffer.from(delegateSeedHash)],
      ACROSS_V4_PROGRAM_ID
    );
    return pda;
  }

  function acrossDelegateForQuote(params: {
    depositor: PublicKey; 
    inputMint: PublicKey;
    inputAmount: number; 
    quoteParams: any; 
  }): PublicKey {
    return acrossDelegateFromDepositSeedData({
      depositor: params.depositor,
      recipient: params.quoteParams.recipient,
      inputToken: params.inputMint,
      outputToken: params.quoteParams.outputToken,
      inputAmount: BigInt(params.inputAmount),
      outputAmount: params.quoteParams.outputAmount,
      destinationChainId: params.quoteParams.destinationChainId.toNumber(),
      exclusiveRelayer: params.quoteParams.exclusiveRelayer,
      quoteTimestamp: params.quoteParams.quoteTimestamp,
      fillDeadline: params.quoteParams.fillDeadline,
      exclusivityParameter: params.quoteParams.exclusivityParameter,
      message: params.quoteParams.message,
    });
  }

  function evmToPublicKey(hex: string): PublicKey {
    const clean = hex.replace("0x", "").toLowerCase();
    const buf = Buffer.alloc(32, 0);
    Buffer.from(clean, "hex").copy(buf, 12);
    return new PublicKey(buf);
  }

  function amountToBytes32(amount: bigint): number[] {
    const buf = Buffer.alloc(32, 0);
    buf.writeBigUInt64BE(amount, 24);
    return Array.from(buf);
  }

  function isAcrossLifiStep(s: any): boolean {
    const tool = String(s?.tool ?? "").toLowerCase();
    const key = String(s?.toolDetails?.key ?? "").toLowerCase();
    return tool === "across" || key === "across" || tool.includes("across");
  }

  function acrossStepHasOutput(est: any): boolean {
    return est?.toAmount != null || est?.toAmountMin != null;
  }

  function findAcrossStepInQuote(quote: any): any | undefined {
    if (isAcrossLifiStep(quote) && acrossStepHasOutput(quote.estimate)) {
      return quote;
    }
    const walk = (steps: any[] | undefined): any | undefined => {
      if (!steps?.length) return undefined;
      for (const s of steps) {
        if (isAcrossLifiStep(s) && acrossStepHasOutput(s.estimate)) return s;
        const nested = walk(s.includedSteps);
        if (nested) return nested;
      }
      return undefined;
    };
    return walk(quote.includedSteps) ?? walk(quote.steps);
  }

  function buildLifiUsdcToUsdcArbQuoteParams(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountMicro: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: USDC_SOLANA.toBase58(),
      toToken: USDC_ARBITRUM_EVM,
      fromAmount: args.fromAmountMicro,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.001,
      allowBridges: LIFI_BRIDGE_ACROSS,
    };
  }

  function buildLifiWsolToWsolArbQuoteParams(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountLamports: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: WSOL_MINT_ADDRESS,
      toToken: WSOL_ARBITRUM_EVM,
      fromAmount: args.fromAmountLamports,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.005,
      allowBridges: LIFI_BRIDGE_ACROSS,
    };
  }

  function buildLifiWsolToWsolArbQuoteParamsRelaxed(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountLamports: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: WSOL_MINT_ADDRESS,
      toToken: WSOL_ARBITRUM_EVM,
      fromAmount: args.fromAmountLamports,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.005,
      preferBridges: LIFI_BRIDGE_ACROSS,
      allowExchanges: "all",
    };
  }

  const LIFI_SKIP_NO_ACROSS_WSOL = "LIFI_SKIP_NO_ACROSS_WSOL";

  async function lifiGetQuote(params: Record<string, string | number | boolean>) {
    return axios.get(`${LIFI_API}/quote`, { params });
  }

  function lifiQuoteParamsToAdvancedRoutesBody(
    params: Record<string, string | number | boolean>
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      fromChainId: Number(params.fromChain),
      toChainId: Number(params.toChain),
      fromTokenAddress: String(params.fromToken),
      toTokenAddress: String(params.toToken),
      fromAmount: String(params.fromAmount),
      fromAddress: String(params.fromAddress),
      toAddress: String(params.toAddress),
      slippage: typeof params.slippage === "number" ? params.slippage : Number(params.slippage),
    };
    if (params.allowBridges != null) body.allowBridges = String(params.allowBridges);
    if (params.preferBridges != null) body.preferBridges = String(params.preferBridges);
    if (params.denyBridges != null) body.denyBridges = String(params.denyBridges);
    if (params.allowExchanges != null) body.allowExchanges = String(params.allowExchanges);
    return body;
  }

  async function lifiPostAdvancedRoutes(params: Record<string, string | number | boolean>) {
    return axios.post(`${LIFI_API}/advanced/routes`, lifiQuoteParamsToAdvancedRoutesBody(params));
  }

  function formatLifiAxiosError(prefix: string, e: unknown): Error {
    if (!axios.isAxiosError(e)) return e instanceof Error ? e : new Error(String(e));
    const status = e.response?.status;
    const body = e.response?.data;
    return new Error(
      `${prefix} HTTP ${status ?? "?"} ${e.message}. LiFi body: ${typeof body === "string" ? body : JSON.stringify(body)}`
    );
  }

  async function getLifiQuoteSOL(
    fromAddress: string,
    toAddress: string,
    amountLamports: number
  ) {
    const base = {
      fromAddress,
      toAddress,
      fromAmountLamports: amountLamports.toString(),
    };
    const attempts: { label: string; params: Record<string, string | number | boolean> }[] = [
      { label: "allowBridges=across", params: buildLifiWsolToWsolArbQuoteParams(base) },
      {
        label: "preferBridges=across + allowExchanges=all",
        params: buildLifiWsolToWsolArbQuoteParamsRelaxed(base),
      },
    ];

    let lastErr: unknown;
    for (const { label, params } of attempts) {
      try {
        const { data } = await lifiGetQuote(params);
        if (findAcrossStepInQuote(data)) {
          return data;
        }
        lastErr = new Error(
          `LiFi (${label}): no Across step in the response (tool=${data?.tool})`
        );
      } catch (e) {
        lastErr = e;
        if (axios.isAxiosError(e) && e.response?.status === 404) {
          continue;
        }
        throw formatLifiAxiosError(`LiFi GET /v1/quote WSOL→SOL(Arb) (${label})`, e);
      }
    }
    if (axios.isAxiosError(lastErr)) {
      const inner = formatLifiAxiosError(
        "LiFi WSOL→SOL(Arb): no quote with strict Across or with relaxed (preferBridges+across). Last error:",
        lastErr
      );
      throw new Error(`${LIFI_SKIP_NO_ACROSS_WSOL}: ${inner.message}`);
    }
    throw new Error(
      `${LIFI_SKIP_NO_ACROSS_WSOL}: LiFi WSOL→SOL(Arb): no quote with strict Across or with relaxed (preferBridges+across). Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  }

  async function getLifiQuoteUSDC(
    fromAddress: string,
    toAddress: string,
    amountMicro: number
  ) {
    let data: any;
    try {
      ({ data } = await lifiGetQuote(
        buildLifiUsdcToUsdcArbQuoteParams({
          fromAddress,
          toAddress,
          fromAmountMicro: amountMicro.toString(),
        })
      ));
    } catch (e) {
      throw formatLifiAxiosError("LiFi GET /v1/quote (USDC→USDC, allowBridges=across).", e);
    }

    if (!findAcrossStepInQuote(data)) {
      throw new Error(
        `LiFi quote has no Across step (root tool: ${data?.tool}). Try allowBridges=across.`
      );
    }

    return data;
  }

  function isRelayLifiStep(s: any): boolean {
    const tool = String(s?.tool ?? "").toLowerCase();
    const key = String(s?.toolDetails?.key ?? "").toLowerCase();
    return tool === "relay" || key.includes("relay") || tool.includes("relay");
  }

  function relayStepHasInput(est: any): boolean {
    return est?.fromAmount != null;
  }

  function findRelayStepInQuote(quote: any): any | undefined {
    if (isRelayLifiStep(quote) && relayStepHasInput(quote.estimate)) {
      return quote;
    }
    const walk = (steps: any[] | undefined): any | undefined => {
      if (!steps?.length) return undefined;
      for (const s of steps) {
        if (isRelayLifiStep(s) && relayStepHasInput(s.estimate)) return s;
        const nested = walk(s.includedSteps);
        if (nested) return nested;
      }
      return undefined;
    };
    return walk(quote.includedSteps) ?? walk(quote.steps);
  }

  function findRelayInRoutesResponse(body: any): { route: any; step: any } | undefined {
    const routes = body?.routes;
    if (!Array.isArray(routes)) return undefined;
    for (const route of routes) {
      const step = findRelayStepInQuote({ steps: route.steps });
      if (step) return { route, step };
    }
    return undefined;
  }

  function relayQuoteFromAdvancedRoute(route: any, relayStep: any): any {
    return {
      id: route.id,
      tool: relayStep.tool,
      toolDetails: relayStep.toolDetails,
      estimate: relayStep.estimate,
      action: relayStep.action,
      steps: route.steps,
      includedSteps: route.steps,
    };
  }

  function buildLifiUsdcToUsdcArbRelayParams(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountMicro: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: USDC_SOLANA.toBase58(),
      toToken: USDC_ARBITRUM_EVM,
      fromAmount: args.fromAmountMicro,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.001,
      allowBridges: LIFI_BRIDGE_RELAY,
    };
  }

  function buildLifiUsdcToUsdcArbRelayParamsManual(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountMicro: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: USDC_SOLANA.toBase58(),
      toToken: USDC_ARBITRUM_EVM,
      fromAmount: args.fromAmountMicro,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.001,
      allowExchanges: "all",
      ...lifiManualRelayOnlyFilters(),
    };
  }

  function buildLifiUsdcToUsdcArbRelayParamsRelaxed(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountMicro: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: USDC_SOLANA.toBase58(),
      toToken: USDC_ARBITRUM_EVM,
      fromAmount: args.fromAmountMicro,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.001,
      preferBridges: LIFI_BRIDGE_RELAY,
      allowExchanges: "all",
      denyBridges: `${LIFI_BRIDGE_ACROSS},${LIFI_BRIDGE_ECO}`,
    };
  }

  function buildLifiWsolToWsolArbRelayParams(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountLamports: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: WSOL_MINT_ADDRESS,
      toToken: WSOL_ARBITRUM_EVM,
      fromAmount: args.fromAmountLamports,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.005,
      allowBridges: LIFI_BRIDGE_RELAY,
    };
  }

  function buildLifiWsolToWsolArbRelayParamsManual(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountLamports: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: WSOL_MINT_ADDRESS,
      toToken: WSOL_ARBITRUM_EVM,
      fromAmount: args.fromAmountLamports,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.005,
      allowExchanges: "all",
      ...lifiManualRelayOnlyFilters(),
    };
  }

  function buildLifiWsolToWsolArbRelayParamsRelaxed(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountLamports: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: WSOL_MINT_ADDRESS,
      toToken: WSOL_ARBITRUM_EVM,
      fromAmount: args.fromAmountLamports,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.005,
      preferBridges: LIFI_BRIDGE_RELAY,
      allowExchanges: "all",
      denyBridges: `${LIFI_BRIDGE_ACROSS},${LIFI_BRIDGE_ECO}`,
    };
  }

  function buildLifiWsolToWethArbRelayParams(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountLamports: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: WSOL_MINT_ADDRESS,
      toToken: WETH_ARBITRUM_EVM,
      fromAmount: args.fromAmountLamports,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.005,
      allowBridges: LIFI_BRIDGE_RELAY,
    };
  }

  function buildLifiWsolToWethArbRelayParamsManual(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountLamports: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: WSOL_MINT_ADDRESS,
      toToken: WETH_ARBITRUM_EVM,
      fromAmount: args.fromAmountLamports,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.005,
      allowExchanges: "all",
      ...lifiManualRelayOnlyFilters(),
    };
  }

  function buildLifiWsolToWethArbRelayParamsRelaxed(args: {
    fromAddress: string;
    toAddress: string;
    fromAmountLamports: string;
  }) {
    return {
      fromChain: SOLANA_CHAIN_ID,
      toChain: ARBITRUM_CHAIN_ID,
      fromToken: WSOL_MINT_ADDRESS,
      toToken: WETH_ARBITRUM_EVM,
      fromAmount: args.fromAmountLamports,
      fromAddress: args.fromAddress,
      toAddress: args.toAddress,
      slippage: 0.005,
      preferBridges: LIFI_BRIDGE_RELAY,
      allowExchanges: "all",
      denyBridges: `${LIFI_BRIDGE_ACROSS},${LIFI_BRIDGE_ECO}`,
    };
  }

  const LIFI_SKIP_NO_RELAY_USDC = "LIFI_SKIP_NO_RELAY_USDC";
  const LIFI_SKIP_NO_RELAY_WSOL = "LIFI_SKIP_NO_RELAY_WSOL";

  async function getLifiQuoteUSDC_Relay(
    fromAddress: string,
    toAddress: string,
    amountMicro: number
  ) {
    const base = {
      fromAddress,
      toAddress,
      fromAmountMicro: amountMicro.toString(),
    };
    const attempts: { label: string; params: Record<string, string | number | boolean> }[] = [
      {
        label: "manual relay (allow+prefer=relay, deny competitors)",
        params: buildLifiUsdcToUsdcArbRelayParamsManual(base),
      },
      { label: "allowBridges=relay", params: buildLifiUsdcToUsdcArbRelayParams(base) },
      {
        label: "allowBridges=relay + denyBridges=across,eco",
        params: {
          ...buildLifiUsdcToUsdcArbRelayParams(base),
          denyBridges: `${LIFI_BRIDGE_ACROSS},${LIFI_BRIDGE_ECO}`,
        },
      },
      {
        label: "preferBridges=relay + allowExchanges=all + denyBridges=across,eco",
        params: buildLifiUsdcToUsdcArbRelayParamsRelaxed(base),
      },
    ];

    let lastErr: unknown;
    for (const { label, params } of attempts) {
      try {
        const { data } = await lifiGetQuote(params);
        if (findRelayStepInQuote(data)) {
          return data;
        }
        lastErr = new Error(
          `LiFi (${label}): no Relay step in the response (tool=${data?.tool})`
        );
      } catch (e) {
        lastErr = e;
        if (axios.isAxiosError(e) && e.response?.status === 404) {
          continue;
        }
        throw formatLifiAxiosError(`LiFi GET /v1/quote USDC→USDC (${label})`, e);
      }
    }
    for (const { label, params } of attempts) {
      try {
        const { data } = await lifiPostAdvancedRoutes(params);
        const found = findRelayInRoutesResponse(data);
        if (found) {
          return relayQuoteFromAdvancedRoute(found.route, found.step);
        }
        lastErr = new Error(
          `LiFi POST /v1/advanced/routes (${label}): no Relay step in any route`
        );
      } catch (e) {
        lastErr = e;
        if (axios.isAxiosError(e) && e.response?.status === 404) {
          continue;
        }
        throw formatLifiAxiosError(`LiFi POST /v1/advanced/routes USDC→USDC (${label})`, e);
      }
    }
    if (axios.isAxiosError(lastErr)) {
      const inner = formatLifiAxiosError(
        "LiFi USDC→USDC (Relay): no quote with strict Relay or relaxed. Last error:",
        lastErr
      );
      throw new Error(`${LIFI_SKIP_NO_RELAY_USDC}: ${inner.message}`);
    }
    throw new Error(
      `${LIFI_SKIP_NO_RELAY_USDC}: LiFi USDC→USDC: no Relay route. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  }

  function quoteFromRelayAdvancedRoutesBody(body: any): any {
    const found = findRelayInRoutesResponse(body);
    if (!found) {
      throw new Error("LiFi advanced/routes: nema Relay koraka u routes[]");
    }
    return relayQuoteFromAdvancedRoute(found.route, found.step);
  }

  function loadRelayUsdcAdvancedRoutesFixture(): any {
    const fixturePath = process.env.LIFI_RELAY_USDC_FIXTURE
      ? path.resolve(process.cwd(), process.env.LIFI_RELAY_USDC_FIXTURE)
      : path.join(__dirname, "fixtures/lifi_relay_usdc_advanced_routes.json");
    if (!fs.existsSync(fixturePath)) {
      throw new Error(
        `Nedostaje fixture ${fixturePath}. Snimi POST /v1/advanced/routes kada Relay za USDC postoji, ili postavi LIFI_RELAY_USDC_FIXTURE na putanju.`
      );
    }
    const raw = fs.readFileSync(fixturePath, "utf8");
    return JSON.parse(raw);
  }

  async function resolveRelayUsdcLifiQuote(
    fromAddress: string,
    toAddress: string,
    amountMicro: number
  ): Promise<{ quote: any; source: "live" | "fixture" }> {
    if (process.env.LIFI_RELAY_USDC_FIXTURE_ONLY === "1") {
      const body = loadRelayUsdcAdvancedRoutesFixture();
      return { quote: quoteFromRelayAdvancedRoutesBody(body), source: "fixture" };
    }

    try {
      const quote = await getLifiQuoteUSDC_Relay(fromAddress, toAddress, amountMicro);
      return { quote, source: "live" };
    } catch (e: unknown) {
      if (process.env.LIFI_RELAY_USDC_NO_FIXTURE === "1") {
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes(LIFI_SKIP_NO_RELAY_USDC)) {
        throw e;
      }
      const body = loadRelayUsdcAdvancedRoutesFixture();
      return { quote: quoteFromRelayAdvancedRoutesBody(body), source: "fixture" };
    }
  }

  async function getLifiQuoteSOL_Relay(
    fromAddress: string,
    toAddress: string,
    amountLamports: number
  ) {
    const base = {
      fromAddress,
      toAddress,
      fromAmountLamports: amountLamports.toString(),
    };
    const attempts: { label: string; params: Record<string, string | number | boolean> }[] = [
      {
        label: "WSOL→Wormhole SOL manual relay",
        params: buildLifiWsolToWsolArbRelayParamsManual(base),
      },
      { label: "WSOL→Wormhole SOL allowBridges=relay", params: buildLifiWsolToWsolArbRelayParams(base) },
      {
        label: "WSOL→Wormhole SOL preferBridges=relay + deny across,eco",
        params: buildLifiWsolToWsolArbRelayParamsRelaxed(base),
      },
      {
        label: "WSOL→WETH manual relay (fallback; relaydepository often has no WSOL→SOL route)",
        params: buildLifiWsolToWethArbRelayParamsManual(base),
      },
      { label: "WSOL→WETH allowBridges=relay", params: buildLifiWsolToWethArbRelayParams(base) },
      {
        label: "WSOL→WETH preferBridges=relay + deny across,eco",
        params: buildLifiWsolToWethArbRelayParamsRelaxed(base),
      },
    ];

    let lastErr: unknown;
    for (const { label, params } of attempts) {
      try {
        const { data } = await lifiGetQuote(params);
        if (findRelayStepInQuote(data)) {
          return data;
        }
        lastErr = new Error(
          `LiFi (${label}): no Relay step in the response (tool=${data?.tool})`
        );
      } catch (e) {
        lastErr = e;
        if (axios.isAxiosError(e) && e.response?.status === 404) {
          continue;
        }
        throw formatLifiAxiosError(`LiFi GET /v1/quote Relay SOL (${label})`, e);
      }
    }
    for (const { label, params } of attempts) {
      try {
        const { data } = await lifiPostAdvancedRoutes(params);
        const found = findRelayInRoutesResponse(data);
        if (found) {
          return relayQuoteFromAdvancedRoute(found.route, found.step);
        }
        lastErr = new Error(
          `LiFi POST /v1/advanced/routes (${label}): no Relay step in any route`
        );
      } catch (e) {
        lastErr = e;
        if (axios.isAxiosError(e) && e.response?.status === 404) {
          continue;
        }
        throw formatLifiAxiosError(`LiFi POST /v1/advanced/routes Relay SOL (${label})`, e);
      }
    }
    if (axios.isAxiosError(lastErr)) {
      const inner = formatLifiAxiosError(
        "LiFi Relay (WSOL→SOL Arb or WSOL→WETH fallback): no quote. Last error:",
        lastErr
      );
      throw new Error(`${LIFI_SKIP_NO_RELAY_WSOL}: ${inner.message}`);
    }
    throw new Error(
      `${LIFI_SKIP_NO_RELAY_WSOL}: LiFi Relay SOL: no route. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
    );
  }

  function relayIdFromLifiQuote(quote: any): number[] {
    const raw =
      quote?.id ??
      quote?.transactionRequest?.from ??
      quote?.action?.transactionId ??
      JSON.stringify(quote?.action ?? {});
    const h = keccak_256(Buffer.from(String(raw)));
    return Array.from(h);
  }

  function relayBridgeInputAmountFromQuote(quote: any, fallbackRequested: number): number {
    const step = findRelayStepInQuote(quote);
    const fromStr = step?.estimate?.fromAmount ?? quote?.estimate?.fromAmount;
    if (fromStr != null) {
      const n = Number(String(fromStr));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return fallbackRequested;
  }

  function buildQuoteParams(quote: any, evmRecipient: string, evmOutputToken: string) {
    const step = findAcrossStepInQuote(quote);
    if (!step) throw new Error("Across step not found in the LiFi quote");

    const est = step.estimate;
    const outputAmount = BigInt(est.toAmount ?? est.toAmountMin);

    const now = Math.floor(Date.now() / 1000);
    const quoteTimestampCandidate =
      step.estimate?.quoteTimestamp ??
      quote.estimate?.quoteTimestamp ??
      now - 60;

    const fillDeadlineCandidate =
      step.estimate?.fillDeadline ??
      quote.estimate?.fillDeadline ??
      now + 21600;

    const normalizeToSeconds = (v: any): number => {
      if (typeof v !== "number") return NaN;
      if (!Number.isFinite(v)) return NaN;
      if (v > 1e10) return Math.floor(v / 1000);
      return Math.floor(v);
    };

    let quoteTimestamp = normalizeToSeconds(quoteTimestampCandidate);
    let fillDeadline = normalizeToSeconds(fillDeadlineCandidate);

    if (!Number.isFinite(quoteTimestamp)) quoteTimestamp = now - 60;
    quoteTimestamp = Math.min(Math.max(quoteTimestamp, now - 3600), now);

    if (!Number.isFinite(fillDeadline)) fillDeadline = now + 21599;
    fillDeadline = Math.min(Math.max(fillDeadline, now + 1), now + 21600 - 1);

    console.log(`    quoteTimestamp : ${quoteTimestamp}`);
    console.log(`    fillDeadline   : ${fillDeadline}`);
    console.log(`    outputAmount   : ${outputAmount}`);

    return {
      recipient: evmToPublicKey(evmRecipient),
      outputToken: evmToPublicKey(evmOutputToken),
      outputAmount: amountToBytes32(outputAmount),
      destinationChainId: new BN(ARBITRUM_CHAIN_ID),
      exclusiveRelayer: PublicKey.default,
      quoteTimestamp,
      fillDeadline,
      exclusivityParameter: 0,
      message: Buffer.from([]),
    };
  }

  async function rpcSurfnetHasSetTokenAmount(endpoint: string): Promise<boolean> {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_setTokenAccountAmount",
        params: [],
      }),
    });
    const json = (await resp.json()) as { error?: { code?: number } };
    return json.error?.code !== -32601;
  }

  async function surfnetSetTokenAmount(
    connection: { rpcEndpoint?: string; _rpcEndpoint?: string },
    tokenAccount: PublicKey,
    mint: PublicKey,
    authority: PublicKey,
    amount: number
  ) {
    const endpoint = connection.rpcEndpoint ?? connection._rpcEndpoint ?? "http://127.0.0.1:8899";
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "surfnet_setTokenAccountAmount",
        params: [
          tokenAccount.toBase58(),
          amount,
          mint.toBase58(),
          authority.toBase58(),
        ],
      }),
    });

    const json = (await resp.json()) as { error?: unknown };
    if (json.error != null) {
      throw new Error(
        `surfnet_setTokenAccountAmount: ${JSON.stringify(json.error)}. ` +
          `Need Surfpool / surfnet RPC (not the standard solana-test-validator) to set USDC on the vault ATA for the mainnet mint.`
      );
    }

    console.log(`Token balance set to: ${amount}`);
  }

  describe("bridgeSpl USDC (AcrossV4)", () => {
    const airdrop = async (kp: Keypair, sol = 10) => {
      const sig = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    };

    let operator: Keypair;
    let recovery: Keypair;

    const EVM_RECIPIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const PORTAL_META_SEED_BUF = Buffer.from("portal_meta");
    const PORTAL_SEED_BUF = Buffer.from("portal");

    const ownerHash = (): number[] => {
      const h = new Array<number>(32).fill(0);
      h[0] = 0xbb;
      return h;
    };

    before(async () => {
      operator = admin.payer as Keypair;
      if (!user1) throw new Error("USER1_SECRET_KEY is not set");
      recovery = user1;
      await airdrop(operator, 10);
      await airdrop(recovery, 5);

      await program.methods
        .updateConfig(operator.publicKey, null)
        .accounts({ authority: admin.publicKey })
        .rpc();

      await program.methods
        .createStealthSplAta(ownerHash())
        .accounts({
          operator: operator.publicKey,
          recovery: recovery.publicKey,
          mint: USDC_SOLANA,
        })
        .signers([operator])
        .rpc();
    });

    it("bridges USDC to Arbitrum via AcrossV4", async () => {
      const BRIDGE_AMOUNT = 1_000_000;

      const ownerBuf = Buffer.from(ownerHash());
      const [vault] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED_BUF, ownerBuf, recovery.publicKey.toBuffer()],
        program.programId
      );
      const vaultAta = getAssociatedTokenAddressSync(USDC_SOLANA, vault, true);

      if (!user1) throw new Error("USER1_SECRET_KEY is not set");

      const user1UsdcAta = getAssociatedTokenAddressSync(USDC_SOLANA, user1.publicKey, true);

      console.log("\n  Checking USDC in source (user1) and stealth destination (vaultAta)...");

      const vaultAcc = await getAccount(connection, vaultAta);
      const vaultBalance = BigInt(vaultAcc.amount.toString());
      console.log(`    vaultAta: ${vaultAta.toBase58()} (vault PDA: ${vault.toBase58()})`);
      console.log(`    vault USDC amount(raw): ${vaultAcc.amount.toString()} (human: ${Number(vaultBalance) / 1e6} USDC)`);

      let user1Acc = await getAccount(connection, user1UsdcAta);
      const user1Balance = BigInt(user1Acc.amount.toString());
      console.log(`    user1 USDC ATA: ${user1UsdcAta.toBase58()}`);
      console.log(`    user1 USDC amount(raw): ${user1Acc.amount.toString()} (human: ${Number(user1Balance) / 1e6} USDC)`);

      const expected = BigInt(BRIDGE_AMOUNT);
      if (vaultBalance > expected) {
        throw new Error(
          `vaultAta already has more than expected. expected=${expected} got=${vaultBalance.toString()} (${vaultAta.toBase58()}). ` +
            `Either withdraw excess or change BRIDGE_AMOUNT.`
        );
      }

      const needed = expected - vaultBalance;
      if (needed > BigInt(0)) {
        console.log(`    transfer ${needed.toString()} raw USDC from user1UsdcAta to vaultAta`);
        if (needed > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(`needed too large for JS number: ${needed.toString()}`);
        }
        const ix = createTransferInstruction(
          user1UsdcAta,
          vaultAta,
          user1.publicKey,
          Number(needed)
        );

        const transferTx = new Transaction().add(ix);
        transferTx.feePayer = user1.publicKey;
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        transferTx.recentBlockhash = blockhash;

        const sig = await connection.sendTransaction(transferTx, [user1], { skipPreflight: true });
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      }

      const vaultAcc2 = await getAccount(connection, vaultAta);
      const vaultBalance2 = BigInt(vaultAcc2.amount.toString());
      console.log(`    after transfer vault USDC amount(raw): ${vaultBalance2.toString()}`);

      if (vaultBalance2 !== expected) {
        throw new Error(
          `Vault USDC balance mismatch after transfer. expected=${expected} got=${vaultBalance2.toString()} (${vaultAta.toBase58()}).`
        );
      }

      console.log("\n  LiFi quote USDC (Solana) to USDC (Arbitrum)...");
      const quote = await getLifiQuoteUSDC(vault.toBase58(), EVM_RECIPIENT, BRIDGE_AMOUNT);

      console.log(`    Tool           : ${quote.toolDetails?.name}`);
      console.log(`    Input          : ${BRIDGE_AMOUNT / 1e6} USDC`);
      console.log(`    Output         : ${Number(BigInt(quote.estimate.toAmount)) / 1e6} USDC`);
      const totalFees = (quote.estimate.feeCosts ?? []).reduce(
        (s: number, f: any) => s + parseFloat(f.amountUSD),
        0
      );
      console.log(`    Total fees: $${totalFees.toFixed(4)}`);

      const quoteParams = buildQuoteParams(quote, EVM_RECIPIENT, USDC_ARBITRUM_EVM);

      const acrossVault = getAssociatedTokenAddressSync(USDC_SOLANA, ACROSS_STATE, true);
      const acrossDelegate = acrossDelegateForQuote({
        depositor: vault,
        inputMint: USDC_SOLANA,
        inputAmount: BRIDGE_AMOUNT,
        quoteParams,
      });
      console.log(`acrossDelegate: ${acrossDelegate.toBase58()}`);

      let tx: string;
      try {
        tx = await program.methods
          .bridgeSpl(ownerHash(), new BN(BRIDGE_AMOUNT), new BN(0), quoteParams)
          .accounts({
            operator: operator.publicKey,
            recovery: recovery.publicKey,
            mint: USDC_SOLANA,
            // @ts-ignore
            acrossProgram: ACROSS_V4_PROGRAM_ID,
            acrossState: ACROSS_STATE,
            acrossDelegate,
            acrossVault,
            acrossEventAuthority: ACROSS_EVENT_AUTHORITY,
          })
          .signers([operator])
          .rpc({ commitment: "confirmed" });
      } catch (e: any) {
        console.error("\n bridgeSpl failed");
        console.error("  vaultAta:", vaultAta.toBase58());
        console.error("  acrossVault:", acrossVault.toBase58());
        console.error("  error:", e);
        if (e?.logs) {
          console.error("  logs:", e.logs);
        }
        throw e;
      }

      console.log(`TX: ${tx}`);

      const [portalPda] = PublicKey.findProgramAddressSync(
        [PORTAL_META_SEED_BUF, ownerBuf, recovery.publicKey.toBuffer()],
        program.programId
      );
      const portal = await program.account.portalAccount.fetch(portalPda);
      expect(portal.isUsed).to.equal(true);
      expect(portal.amountWithdrawn.toNumber()).to.equal(BRIDGE_AMOUNT);
      expect(portal.currencyMint.toBase58()).to.equal(USDC_SOLANA.toBase58());
    });

    it("fails when the vault_token_account is empty", async () => {
      const emptyRecovery = Keypair.generate();
      await airdrop(emptyRecovery, 2);

      const emptyHash = (): number[] => {
        const h = new Array<number>(32).fill(0);
        h[0] = 0xdd;
        return h;
      };

      await program.methods
        .createStealthSplAta(emptyHash())
        .accounts({
          operator: operator.publicKey,
          recovery: emptyRecovery.publicKey,
          mint: USDC_SOLANA,
        })
        .signers([operator])
        .rpc();

      const dummyQuoteParams = {
        recipient: evmToPublicKey(EVM_RECIPIENT),
        outputToken: evmToPublicKey(USDC_ARBITRUM_EVM),
        outputAmount: amountToBytes32(BigInt(990_000)),
        destinationChainId: new BN(ARBITRUM_CHAIN_ID),
        exclusiveRelayer: PublicKey.default,
        quoteTimestamp: Math.floor(Date.now() / 1000) - 60,
        fillDeadline: Math.floor(Date.now() / 1000) + 21600,
        exclusivityParameter: 0,
        message: Buffer.from([]),
      };

      const acrossVault = getAssociatedTokenAddressSync(USDC_SOLANA, ACROSS_STATE, true);
      const [emptyVault] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED_BUF, Buffer.from(emptyHash()), emptyRecovery.publicKey.toBuffer()],
        program.programId
      );
      const emptyVaultAta = getAssociatedTokenAddressSync(USDC_SOLANA, emptyVault, true);
      const acrossDelegate = acrossDelegateForQuote({
        depositor: emptyVault,
        inputMint: USDC_SOLANA,
        inputAmount: 1_000_000,
        quoteParams: dummyQuoteParams,
      });

      try {
        await program.methods
          .bridgeSpl(emptyHash(), new BN(1_000_000), new BN(0), dummyQuoteParams)
          .accounts({
            operator: operator.publicKey,
            recovery: emptyRecovery.publicKey,
            mint: USDC_SOLANA,
            // @ts-ignore
            acrossProgram: ACROSS_V4_PROGRAM_ID,
            acrossState: ACROSS_STATE,
            acrossDelegate,
            acrossVault,
            acrossEventAuthority: ACROSS_EVENT_AUTHORITY,
          })
          .signers([operator])
          .rpc();
        expect.fail("Expected failure due to an empty token account");
      } catch (e: any) {
        const msg = String(e.message ?? e);
        const code = e.error?.errorCode?.code;
        expect(
          msg.includes("EmptyVaultTokenAccount") ||
          msg.includes("AcrossInputAmountMismatch") ||
          code === "EmptyVaultTokenAccount" ||
          code === "AcrossInputAmountMismatch"
        ).to.be.true;
      }
    });
  });

  describe("bridgeRelay (RelayDepository)", () => {
    const airdrop = async (kp: Keypair, sol = 10) => {
      const sig = await connection.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    };

    let operator: Keypair;
    let recoverySpl: Keypair;
    let recoverySol: Keypair;

    const EVM_RECIPIENT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
    const RELAY_PROGRAM_ID = new PublicKey("99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2");
    const RELAY_DEPOSITORY_SEED = Buffer.from("relay_depository");
    const RELAY_VAULT_SEED = Buffer.from("vault");
    const PORTAL_SEED_BUF = Buffer.from("portal");
    const PORTAL_META_SEED_BUF = Buffer.from("portal_meta");

    const ownerHashSpl = (): number[] => {
      const h = new Array<number>(32).fill(0);
      h[0] = 0xf1;
      return h;
    };

    const ownerHashSol = (): number[] => {
      const h = new Array<number>(32).fill(0);
      h[0] = 0xf2;
      return h;
    };

    before(async () => {
      operator = admin.payer as Keypair;
      if (!user1) throw new Error("USER1_SECRET_KEY is not set");
      recoverySpl = user1;
      recoverySol = user1;
      await airdrop(operator, 10);
      await airdrop(recoverySpl, 5);

      await program.methods
        .updateConfig(operator.publicKey, null)
        .accounts({ authority: admin.publicKey })
        .rpc();

      await program.methods
        .createStealthSplAta(ownerHashSpl())
        .accounts({
          operator: operator.publicKey,
          recovery: recoverySpl.publicKey,
          mint: USDC_SOLANA,
        })
        .signers([operator])
        .rpc();

      await program.methods
        .createStealthSol(ownerHashSol())
        .accounts({
          operator: operator.publicKey,
          recovery: recoverySol.publicKey,
        })
        .signers([operator])
        .rpc();
    });

    it("bridges SOL through Relay", async () => {
      const BRIDGE_LAMPORTS = 100_000_000;
      const ownerBuf = Buffer.from(ownerHashSol());
      const [relayDepository] = PublicKey.findProgramAddressSync(
        [RELAY_DEPOSITORY_SEED],
        RELAY_PROGRAM_ID
      );
      const [relayVault] = PublicKey.findProgramAddressSync([RELAY_VAULT_SEED], RELAY_PROGRAM_ID);
      const [vault] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED_BUF, ownerBuf, recoverySol.publicKey.toBuffer()],
        program.programId
      );

      console.log(
        "\n  LiFi Relay: first try WSOL to Wormhole SOL, fallback to WSOL to WETH (same vault / native bridge)..."
      );
      const quote = await getLifiQuoteSOL_Relay(vault.toBase58(), EVM_RECIPIENT, BRIDGE_LAMPORTS);
      const relayStep = findRelayStepInQuote(quote);
      console.log(`    LiFi tool       : ${quote.toolDetails?.name ?? quote.tool}`);
      console.log(`    Relay step tool : ${relayStep?.toolDetails?.name ?? relayStep?.tool}`);
      const relayIdBytes = relayIdFromLifiQuote(quote);
      console.log(`    relay_id (keccak LiFi id): [${relayIdBytes.slice(0, 4).join(",")}]...`);

      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: vault,
            lamports: BRIDGE_LAMPORTS + 5_000_000,
          })
        )
      );

      const tx = await (program as any).methods
        .bridgeRelaySol(ownerHashSol(), new BN(BRIDGE_LAMPORTS), relayIdBytes)
        .accounts({
          operator: operator.publicKey,
          recovery: recoverySol.publicKey,
          relayProgram: RELAY_PROGRAM_ID,
          relayDepository,
          relayVault,
          systemProgram: SystemProgram.programId,
        })
        .signers([operator])
        .rpc({ commitment: "confirmed" });

      expect(tx).to.be.a("string");

      const [portalPda] = PublicKey.findProgramAddressSync(
        [PORTAL_META_SEED_BUF, ownerBuf, recoverySol.publicKey.toBuffer()],
        program.programId
      );
      const portal = await program.account.portalAccount.fetch(portalPda);
      expect(portal.isUsed).to.equal(true);
      expect(portal.amountWithdrawn.toNumber()).to.equal(BRIDGE_LAMPORTS);
    });

    it("bridges USDC through Relay", async () => {
      const BRIDGE_AMOUNT = 1_000_000;
      if (!user1) throw new Error("USER1_SECRET_KEY is not set");

      const ownerBuf = Buffer.from(ownerHashSpl());
      const [relayDepository] = PublicKey.findProgramAddressSync(
        [RELAY_DEPOSITORY_SEED],
        RELAY_PROGRAM_ID
      );
      const [relayVault] = PublicKey.findProgramAddressSync([RELAY_VAULT_SEED], RELAY_PROGRAM_ID);
      const relayVaultTokenAccount = getAssociatedTokenAddressSync(USDC_SOLANA, relayVault, true);

      const [vault] = PublicKey.findProgramAddressSync(
        [PORTAL_SEED_BUF, ownerBuf, recoverySpl.publicKey.toBuffer()],
        program.programId
      );
      const vaultAta = getAssociatedTokenAddressSync(USDC_SOLANA, vault, true);
      const user1UsdcAta = getAssociatedTokenAddressSync(USDC_SOLANA, user1.publicKey, true);

      console.log("\n  LiFi quote USDC (Solana) to USDC (Arbitrum), Relay only...");
      const { quote, source } = await resolveRelayUsdcLifiQuote(
        vault.toBase58(),
        EVM_RECIPIENT,
        BRIDGE_AMOUNT
      );
      if (source === "live") {
        console.log("source: LiFi (live: /quote or POST /advanced/routes)");
      } else {
        console.log(
          "source: fixture (simulated POST /v1/advanced/routes - same parser as UI)"
        );
      }
      const relayStep = findRelayStepInQuote(quote);
      console.log(`    LiFi tool       : ${quote.toolDetails?.name ?? quote.tool}`);
      console.log(`    Relay step tool : ${relayStep?.toolDetails?.name ?? relayStep?.tool}`);
      const amountFromQuote = relayBridgeInputAmountFromQuote(quote, BRIDGE_AMOUNT);
      if (amountFromQuote !== BRIDGE_AMOUNT) {
        console.log(
          `    Note: LiFi estimate.fromAmount (${amountFromQuote}) differs from requested ${BRIDGE_AMOUNT}; using requested for vault funding.`
        );
      }
      const relayIdBytes = relayIdFromLifiQuote(quote);
      console.log(`    relay_id (keccak route/quote id): [${relayIdBytes.slice(0, 4).join(",")}...]`);

      const vaultAcc = await getAccount(connection, vaultAta);
      const vaultBalance = BigInt(vaultAcc.amount.toString());
      const expected = BigInt(BRIDGE_AMOUNT);
      if (vaultBalance > expected) {
        throw new Error(
          `vaultAta already has more than expected. expected=${expected} got=${vaultBalance.toString()} (${vaultAta.toBase58()}).`
        );
      }

      const needed = expected - vaultBalance;
      if (needed > BigInt(0)) {
        const ix = createTransferInstruction(user1UsdcAta, vaultAta, user1.publicKey, Number(needed));
        const transferTx = new Transaction().add(ix);
        transferTx.feePayer = user1.publicKey;
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        transferTx.recentBlockhash = blockhash;
        const sig = await connection.sendTransaction(transferTx, [user1], { skipPreflight: true });
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      }

      const tx = await (program as any).methods
        .bridgeRelaySpl(ownerHashSpl(), new BN(BRIDGE_AMOUNT), relayIdBytes)
        .accounts({
          operator: operator.publicKey,
          recovery: recoverySpl.publicKey,
          mint: USDC_SOLANA,
          relayProgram: RELAY_PROGRAM_ID,
          relayDepository,
          relayVault,
          relayVaultTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([operator])
        .rpc({ commitment: "confirmed" });

      expect(tx).to.be.a("string");

      const [portalPda] = PublicKey.findProgramAddressSync(
        [PORTAL_META_SEED_BUF, ownerBuf, recoverySpl.publicKey.toBuffer()],
        program.programId
      );
      const portal = await program.account.portalAccount.fetch(portalPda);
      expect(portal.isUsed).to.equal(true);
      expect(portal.amountWithdrawn.toNumber()).to.equal(BRIDGE_AMOUNT);
      expect(portal.currencyMint.toBase58()).to.equal(USDC_SOLANA.toBase58());
    });

  });
});
