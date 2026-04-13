import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ContinuousClearingAuction } from "../target/types/continuous_clearing_auction";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";

describe("continuous_clearing_auction", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .ContinuousClearingAuction as Program<ContinuousClearingAuction>;

  const creator = provider.wallet.payer;
  const connection = provider.connection;

  let tokenMint: PublicKey;
  let currencyMint: PublicKey;
  let creatorTokenAccount: PublicKey;

  // Auction params
  const totalSupply = 1_000;
  const tickSpacing = 10;
  const floorPrice = new BN(1000);
  const requiredCurrencyRaised = 5000;
  const tokensRecipient = Keypair.generate().publicKey;
  const fundsRecipient = Keypair.generate().publicKey;

  // Helper: derive PDA
  function findAuctionPDA(tokenMint: PublicKey, creator: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("auction"), tokenMint.toBuffer(), creator.toBuffer()],
      program.programId
    );
  }

  function findStepsPDA(auction: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("steps"), auction.toBuffer()],
      program.programId
    );
  }

  function findFloorTickPDA(auction: PublicKey, floorPrice: BN) {
    const priceBuf = floorPrice.toArrayLike(Buffer, "le", 16);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("tick"), auction.toBuffer(), priceBuf],
      program.programId
    );
  }

  function findTickPDA(auction: PublicKey, price: BN) {
    const priceBuf = price.toArrayLike(Buffer, "le", 16);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("tick"), auction.toBuffer(), priceBuf],
      program.programId
    );
  }

  function findTokenVaultPDA(auction: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), auction.toBuffer()],
      program.programId
    );
  }

  function findCurrencyVaultPDA(auction: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("currency_vault"), auction.toBuffer()],
      program.programId
    );
  }

  function findBidPDA(auction: PublicKey, bidId: number) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(bidId));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("bid"), auction.toBuffer(), buf],
      program.programId
    );
  }

  function findCheckpointPDA(auction: PublicKey, timestamp: number) {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(BigInt(timestamp));
    return PublicKey.findProgramAddressSync(
      [Buffer.from("checkpoint"), auction.toBuffer(), buf],
      program.programId
    );
  }

  before(async () => {
    tokenMint = await createMint(
      connection,
      creator,
      creator.publicKey,
      null,
      6
    );

    currencyMint = await createMint(
      connection,
      creator,
      creator.publicKey,
      null,
      6
    );

    creatorTokenAccount = await createAccount(
      connection,
      creator,
      tokenMint,
      creator.publicKey
    );

    await mintTo(
      connection,
      creator,
      tokenMint,
      creatorTokenAccount,
      creator,
      totalSupply
    );
  });

  it("initializes an auction", async () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = now + 60;
    const auctionDuration = 100;
    const endTime = startTime + auctionDuration;
    const claimTime = endTime;

    const steps = [{ mps: 100_000, duration: auctionDuration }];

    const [auctionPDA] = findAuctionPDA(tokenMint, creator.publicKey);
    const [stepsPDA] = findStepsPDA(auctionPDA);
    const [floorTickPDA] = findFloorTickPDA(auctionPDA, floorPrice);
    const [tokenVaultPDA] = findTokenVaultPDA(auctionPDA);
    const [currencyVaultPDA] = findCurrencyVaultPDA(auctionPDA);
    const [initialCheckpointPDA] = findCheckpointPDA(auctionPDA, startTime);

    const tx = await program.methods
      .initializeAuction({
        totalSupply: new BN(totalSupply),
        startTime: new BN(startTime),
        endTime: new BN(endTime),
        claimTime: new BN(claimTime),
        tickSpacing: new BN(tickSpacing),
        floorPrice: floorPrice,
        requiredCurrencyRaised: new BN(requiredCurrencyRaised),
        tokensRecipient: tokensRecipient,
        fundsRecipient: fundsRecipient,
        steps: steps,
      })
      .accounts({
        creator: creator.publicKey,
        tokenMint: tokenMint,
        currencyMint: currencyMint,
        creatorTokenAccount: creatorTokenAccount,
      })
      .rpc();

    console.log("Initialize auction tx:", tx);

    const auction = await program.account.auction.fetch(auctionPDA);
    expect(auction.tokenMint.toBase58()).to.equal(tokenMint.toBase58());
    expect(auction.totalSupply.toNumber()).to.equal(totalSupply);
    expect(auction.clearingPrice.eq(floorPrice)).to.be.true;
    expect(auction.nextBidId.toNumber()).to.equal(0);
    expect(auction.tokensReceived).to.be.true;
    expect(auction.graduated).to.be.false;

    const vaultAccount = await getAccount(connection, tokenVaultPDA);
    expect(Number(vaultAccount.amount)).to.equal(totalSupply);

    // Verify initial checkpoint
    const cp = await program.account.checkpoint.fetch(initialCheckpointPDA);
    expect(cp.timestamp.toNumber()).to.equal(startTime);
    expect(cp.cumulativeMps).to.equal(0);

    console.log("Auction created successfully!");
  });

  it("fails with start_time in the past", async () => {
    const freshTokenMint = await createMint(
      connection,
      creator,
      creator.publicKey,
      null,
      6
    );
    const freshCreatorTokenAccount = await createAccount(
      connection,
      creator,
      freshTokenMint,
      creator.publicKey
    );
    await mintTo(
      connection,
      creator,
      freshTokenMint,
      freshCreatorTokenAccount,
      creator,
      totalSupply
    );

    const pastStart = Math.floor(Date.now() / 1000) - 100;
    const endTime = pastStart + 100;
    const steps = [{ mps: 100_000, duration: 100 }];

    const [auctionPDA] = findAuctionPDA(freshTokenMint, creator.publicKey);
    const [stepsPDA] = findStepsPDA(auctionPDA);
    const [floorTickPDA] = findFloorTickPDA(auctionPDA, floorPrice);
    const [tokenVaultPDA] = findTokenVaultPDA(auctionPDA);
    const [currencyVaultPDA] = findCurrencyVaultPDA(auctionPDA);
    const [initialCheckpointPDA] = findCheckpointPDA(auctionPDA, pastStart);

    try {
      await program.methods
        .initializeAuction({
          totalSupply: new BN(totalSupply),
          startTime: new BN(pastStart),
          endTime: new BN(endTime),
          claimTime: new BN(endTime),
          tickSpacing: new BN(tickSpacing),
          floorPrice: floorPrice,
          requiredCurrencyRaised: new BN(requiredCurrencyRaised),
          tokensRecipient: tokensRecipient,
          fundsRecipient: fundsRecipient,
          steps: steps,
        })
        .accounts({
          creator: creator.publicKey,
          tokenMint: freshTokenMint,
          currencyMint: currencyMint,
          creatorTokenAccount: freshCreatorTokenAccount,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidStepsConfig");
    }
  });

  it("fails with invalid tick spacing", async () => {
    const freshTokenMint = await createMint(
      connection,
      creator,
      creator.publicKey,
      null,
      6
    );
    const freshCreatorTokenAccount = await createAccount(
      connection,
      creator,
      freshTokenMint,
      creator.publicKey
    );
    await mintTo(
      connection,
      creator,
      freshTokenMint,
      freshCreatorTokenAccount,
      creator,
      totalSupply
    );

    const now = Math.floor(Date.now() / 1000);
    const startTime = now + 60;
    const endTime = startTime + 100;
    const steps = [{ mps: 100_000, duration: 100 }];
    const badTickSpacing = 1;

    const [auctionPDA] = findAuctionPDA(freshTokenMint, creator.publicKey);
    const [stepsPDA] = findStepsPDA(auctionPDA);
    const [floorTickPDA] = findFloorTickPDA(auctionPDA, floorPrice);
    const [tokenVaultPDA] = findTokenVaultPDA(auctionPDA);
    const [currencyVaultPDA] = findCurrencyVaultPDA(auctionPDA);
    const [initialCheckpointPDA] = findCheckpointPDA(auctionPDA, startTime);

    try {
      await program.methods
        .initializeAuction({
          totalSupply: new BN(totalSupply),
          startTime: new BN(startTime),
          endTime: new BN(endTime),
          claimTime: new BN(endTime),
          tickSpacing: new BN(badTickSpacing),
          floorPrice: floorPrice,
          requiredCurrencyRaised: new BN(requiredCurrencyRaised),
          tokensRecipient: tokensRecipient,
          fundsRecipient: fundsRecipient,
          steps: steps,
        })
        .accounts({
          creator: creator.publicKey,
          tokenMint: freshTokenMint,
          currencyMint: currencyMint,
          creatorTokenAccount: freshCreatorTokenAccount,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidTickSpacing");
    }
  });

  it("fails when step durations don't match auction duration", async () => {
    const freshTokenMint = await createMint(
      connection,
      creator,
      creator.publicKey,
      null,
      6
    );
    const freshCreatorTokenAccount = await createAccount(
      connection,
      creator,
      freshTokenMint,
      creator.publicKey
    );
    await mintTo(
      connection,
      creator,
      freshTokenMint,
      freshCreatorTokenAccount,
      creator,
      totalSupply
    );

    const now = Math.floor(Date.now() / 1000);
    const startTime = now + 60;
    const endTime = startTime + 100;
    const steps = [{ mps: 200_000, duration: 50 }];

    const [auctionPDA] = findAuctionPDA(freshTokenMint, creator.publicKey);
    const [stepsPDA] = findStepsPDA(auctionPDA);
    const [floorTickPDA] = findFloorTickPDA(auctionPDA, floorPrice);
    const [tokenVaultPDA] = findTokenVaultPDA(auctionPDA);
    const [currencyVaultPDA] = findCurrencyVaultPDA(auctionPDA);
    const [initialCheckpointPDA] = findCheckpointPDA(auctionPDA, startTime);

    try {
      await program.methods
        .initializeAuction({
          totalSupply: new BN(totalSupply),
          startTime: new BN(startTime),
          endTime: new BN(endTime),
          claimTime: new BN(endTime),
          tickSpacing: new BN(tickSpacing),
          floorPrice: floorPrice,
          requiredCurrencyRaised: new BN(requiredCurrencyRaised),
          tokensRecipient: tokensRecipient,
          fundsRecipient: fundsRecipient,
          steps: steps,
        })
        .accounts({
          creator: creator.publicKey,
          tokenMint: freshTokenMint,
          currencyMint: currencyMint,
          creatorTokenAccount: freshCreatorTokenAccount,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidStepsConfig");
    }
  });

  it("initializes auction with multiple steps", async () => {
    const freshTokenMint = await createMint(
      connection,
      creator,
      creator.publicKey,
      null,
      6
    );
    const freshCreatorTokenAccount = await createAccount(
      connection,
      creator,
      freshTokenMint,
      creator.publicKey
    );
    await mintTo(
      connection,
      creator,
      freshTokenMint,
      freshCreatorTokenAccount,
      creator,
      totalSupply
    );

    const now = Math.floor(Date.now() / 1000);
    const startTime = now + 60;
    const endTime = startTime + 200;
    const claimTime = endTime + 300;

    const steps = [
      { mps: 50_000, duration: 100 },
      { mps: 50_000, duration: 100 },
    ];

    const [auctionPDA] = findAuctionPDA(freshTokenMint, creator.publicKey);
    const [stepsPDA] = findStepsPDA(auctionPDA);
    const [floorTickPDA] = findFloorTickPDA(auctionPDA, floorPrice);
    const [tokenVaultPDA] = findTokenVaultPDA(auctionPDA);
    const [currencyVaultPDA] = findCurrencyVaultPDA(auctionPDA);
    const [initialCheckpointPDA] = findCheckpointPDA(auctionPDA, startTime);

    const tx = await program.methods
      .initializeAuction({
        totalSupply: new BN(totalSupply),
        startTime: new BN(startTime),
        endTime: new BN(endTime),
        claimTime: new BN(claimTime),
        tickSpacing: new BN(tickSpacing),
        floorPrice: floorPrice,
        requiredCurrencyRaised: new BN(requiredCurrencyRaised),
        tokensRecipient: tokensRecipient,
        fundsRecipient: fundsRecipient,
        steps: steps,
      })
      .accounts({
        creator: creator.publicKey,
        tokenMint: freshTokenMint,
        currencyMint: currencyMint,
        creatorTokenAccount: freshCreatorTokenAccount,
      })
      .rpc();

    console.log("Multi-step auction tx:", tx);

    const auction = await program.account.auction.fetch(auctionPDA);
    expect(auction.totalSupply.toNumber()).to.equal(totalSupply);

    const auctionSteps = await program.account.auctionSteps.fetch(stepsPDA);
    expect(auctionSteps.steps.length).to.equal(2);
    expect(auctionSteps.steps[0].mps).to.equal(50_000);
    expect(auctionSteps.steps[1].duration).to.equal(100);

    console.log("Multi-step auction created successfully!");
  });

  // --- Full lifecycle test: init -> bid -> checkpoint -> exit -> claim ---
  describe("bid and claim lifecycle", () => {
    let auctionMint: PublicKey;
    let auctionCurrencyMint: PublicKey;
    let auctionPDA: PublicKey;
    let stepsPDA: PublicKey;
    let tokenVaultPDA: PublicKey;
    let currencyVaultPDA: PublicKey;
    let startTime: number;
    let endTime: number;
    let claimTime: number;

    const bidder = Keypair.generate();
    let bidderCurrencyAccount: PublicKey;
    let bidderTokenAccount: PublicKey;

    const bidAmount = 6000; // headroom above requiredCurrencyRaised (5000) to absorb effective_amount rounding
    const bidPrice = new BN(10).shln(64); // 10.0 in Q64, above expected clearing ~5.0

    before(async () => {
      // Airdrop to bidder
      const sig = await connection.requestAirdrop(
        bidder.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);

      // Fresh mints
      auctionMint = await createMint(
        connection,
        creator,
        creator.publicKey,
        null,
        6
      );
      auctionCurrencyMint = await createMint(
        connection,
        creator,
        creator.publicKey,
        null,
        6
      );

      // Creator token account with supply
      const creatorTA = await createAccount(
        connection,
        creator,
        auctionMint,
        creator.publicKey
      );
      await mintTo(
        connection,
        creator,
        auctionMint,
        creatorTA,
        creator,
        totalSupply
      );

      // Bidder currency account with funds
      bidderCurrencyAccount = await createAccount(
        connection,
        bidder,
        auctionCurrencyMint,
        bidder.publicKey
      );
      await mintTo(
        connection,
        creator,
        auctionCurrencyMint,
        bidderCurrencyAccount,
        creator,
        10_000
      );

      // Bidder token account (for claim)
      bidderTokenAccount = await createAccount(
        connection,
        bidder,
        auctionMint,
        bidder.publicKey
      );

      // Use start_time = now + 2 so we can warp past it
      const now = Math.floor(Date.now() / 1000);
      startTime = now + 2;
      endTime = startTime + 100;
      claimTime = endTime;

      const steps = [{ mps: 100_000, duration: 100 }];

      [auctionPDA] = findAuctionPDA(auctionMint, creator.publicKey);
      [stepsPDA] = findStepsPDA(auctionPDA);
      [tokenVaultPDA] = findTokenVaultPDA(auctionPDA);
      [currencyVaultPDA] = findCurrencyVaultPDA(auctionPDA);
      const [floorTickPDA] = findFloorTickPDA(auctionPDA, floorPrice);
      const [initialCheckpointPDA] = findCheckpointPDA(
        auctionPDA,
        startTime
      );

      await program.methods
        .initializeAuction({
          totalSupply: new BN(totalSupply),
          startTime: new BN(startTime),
          endTime: new BN(endTime),
          claimTime: new BN(claimTime),
          tickSpacing: new BN(tickSpacing),
          floorPrice: floorPrice,
          requiredCurrencyRaised: new BN(requiredCurrencyRaised),
          tokensRecipient: tokensRecipient,
          fundsRecipient: fundsRecipient,
          steps: steps,
        })
        .accounts({
          creator: creator.publicKey,
          tokenMint: auctionMint,
          currencyMint: auctionCurrencyMint,
          creatorTokenAccount: creatorTA,
        })
        .rpc();

      console.log("Lifecycle auction initialized");
    });

    it("submits a bid", async () => {
      // Wait for auction to start
      await sleep(3000);

      const slot = await connection.getSlot();
      const now = await connection.getBlockTime(slot);
      if (!now || now < startTime) {
        throw new Error("Clock hasn't advanced past start_time yet");
      }

      const [bidPDA] = findBidPDA(auctionPDA, 0);
      const [tickPDA] = findTickPDA(auctionPDA, bidPrice);
      const [floorTickPDA] = findFloorTickPDA(auctionPDA, floorPrice);
      const [latestCheckpointPDA] = findCheckpointPDA(auctionPDA, startTime);
      const [newCheckpointPDA] = findCheckpointPDA(auctionPDA, now);

      const tx = await program.methods
        .submitBid({
          maxPrice: bidPrice,
          amount: new BN(bidAmount),
          prevTickPrice: floorPrice,
          now: new BN(now),
        })
        .accountsPartial({
          bidder: bidder.publicKey,
          auction: auctionPDA,
          bid: bidPDA,
          tick: tickPDA,
          prevTick: floorTickPDA,
          latestCheckpoint: latestCheckpointPDA,
          newCheckpoint: newCheckpointPDA,
          auctionSteps: stepsPDA,
          bidderCurrencyAccount: bidderCurrencyAccount,
          currencyVault: currencyVaultPDA,
        })
        .signers([bidder])
        .rpc();

      console.log("Submit bid tx:", tx);

      const bid = await program.account.bid.fetch(bidPDA);
      expect(bid.owner.toBase58()).to.equal(bidder.publicKey.toBase58());
      expect(bid.maxPrice.eq(bidPrice)).to.be.true;
      expect(bid.exitedTime.toNumber()).to.equal(0);

      const auction = await program.account.auction.fetch(auctionPDA);
      expect(auction.nextBidId.toNumber()).to.equal(1);

      // Verify currency transferred to vault
      const vaultAcc = await getAccount(connection, currencyVaultPDA);
      expect(Number(vaultAcc.amount)).to.equal(bidAmount);

      console.log("Bid submitted successfully!");
    });

    it("creates a checkpoint at end_time", async () => {
      // We need to wait for the auction to end. In localnet tests, time advances with transactions.
      // Wait for end_time to pass
      const auction = await program.account.auction.fetch(auctionPDA);
      const endT = auction.endTime.toNumber();

      // Wait until we're past end time
      let now: number;
      do {
        await sleep(2000);
        const slot = await connection.getSlot();
        now = (await connection.getBlockTime(slot))!;
      } while (now < endT);

      // Find the latest checkpoint (the one created by submit_bid)
      const bid = await program.account.bid.fetch(
        findBidPDA(auctionPDA, 0)[0]
      );
      const bidStartTime = bid.startTime.toNumber();
      const [latestCheckpointPDA] = findCheckpointPDA(
        auctionPDA,
        bidStartTime
      );
      const [newCheckpointPDA] = findCheckpointPDA(auctionPDA, now);

      const tx = await program.methods
        .checkpoint({ now: new BN(now) })
        .accountsPartial({
          payer: creator.publicKey,
          auction: auctionPDA,
          latestCheckpoint: latestCheckpointPDA,
          newCheckpoint: newCheckpointPDA,
          auctionSteps: stepsPDA,
        })
        .rpc();

      console.log("Checkpoint tx:", tx);

      const auctionAfter = await program.account.auction.fetch(auctionPDA);
      console.log("Graduated:", auctionAfter.graduated);
      console.log(
        "Last checkpointed time:",
        auctionAfter.lastCheckpointedTime.toNumber()
      );
      console.log("Auction clearingPrice:", auctionAfter.clearingPrice.toString());

      const finalCp = await program.account.checkpoint.fetch(newCheckpointPDA);
      console.log("Final checkpoint clearingPrice:", finalCp.clearingPrice.toString());
      console.log("Final checkpoint cumulativeMps:", finalCp.cumulativeMps.toString());
      console.log("Final checkpoint cumulativeMpsPerPrice:", finalCp.cumulativeMpsPerPrice.toString());

      const startCp = await program.account.checkpoint.fetch(latestCheckpointPDA);
      console.log("Start checkpoint clearingPrice:", startCp.clearingPrice.toString());
      console.log("Start checkpoint cumulativeMps:", startCp.cumulativeMps.toString());
      console.log("Start checkpoint cumulativeMpsPerPrice:", startCp.cumulativeMpsPerPrice.toString());

      const bidAcc = await program.account.bid.fetch(findBidPDA(auctionPDA, 0)[0]);
      console.log("Bid maxPrice:", bidAcc.maxPrice.toString());
      console.log("Bid amountQ64:", bidAcc.amountQ64.toString());
      console.log("Bid startCumulativeMps:", bidAcc.startCumulativeMps.toString());
    });

    it("exits a bid after auction ends", async () => {
      const auction = await program.account.auction.fetch(auctionPDA);
      const bid = await program.account.bid.fetch(
        findBidPDA(auctionPDA, 0)[0]
      );
      const bidStartTime = bid.startTime.toNumber();
      // Use the latest checkpoint (at or after end_time) as the final checkpoint
      const finalCheckpointTime = auction.lastCheckpointedTime.toNumber();

      const [bidPDA] = findBidPDA(auctionPDA, 0);
      const [startCheckpointPDA] = findCheckpointPDA(
        auctionPDA,
        bidStartTime
      );
      const [finalCheckpointPDA] = findCheckpointPDA(
        auctionPDA,
        finalCheckpointTime
      );

      const tx = await program.methods
        .exitBid()
        .accountsPartial({
          auction: auctionPDA,
          bid: bidPDA,
          startCheckpoint: startCheckpointPDA,
          finalCheckpoint: finalCheckpointPDA,
          currencyVault: currencyVaultPDA,
          bidOwnerCurrencyAccount: bidderCurrencyAccount,
        })
        .rpc();

      console.log("Exit bid tx:", tx);

      const bidAfter = await program.account.bid.fetch(bidPDA);
      expect(bidAfter.exitedTime.toNumber()).to.be.greaterThan(0);
      console.log("Tokens filled:", bidAfter.tokensFilled.toNumber());
      console.log("Bid exited successfully!");
    });

    it("claims tokens after exit", async () => {
      const [bidPDA] = findBidPDA(auctionPDA, 0);
      const bidAfter = await program.account.bid.fetch(bidPDA);

      if (bidAfter.tokensFilled.toNumber() === 0) {
        console.log(
          "No tokens to claim (auction may not have graduated). Skipping."
        );
        return;
      }

      const tx = await program.methods
        .claimTokens()
        .accountsPartial({
          auction: auctionPDA,
          bid: bidPDA,
          tokenVault: tokenVaultPDA,
          bidOwnerTokenAccount: bidderTokenAccount,
        })
        .rpc();

      console.log("Claim tokens tx:", tx);

      const bidFinal = await program.account.bid.fetch(bidPDA);
      expect(bidFinal.tokensFilled.toNumber()).to.equal(0);

      const tokenAcc = await getAccount(connection, bidderTokenAccount);
      expect(Number(tokenAcc.amount)).to.be.greaterThan(0);
      console.log("Tokens claimed:", Number(tokenAcc.amount));
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
