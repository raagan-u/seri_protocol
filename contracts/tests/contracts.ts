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

      // const tx = await program.methods
      //   .submitBid({
      //     maxPrice: bidPrice,
      //     amount: new BN(bidAmount),
      //     prevTickPrice: floorPrice,
      //     now: new BN(now),
      //   })
      //   .accountsPartial({
      //     bidder: bidder.publicKey,
      //     auction: auctionPDA,
      //     bid: bidPDA,
      //     tick: tickPDA,
      //     prevTick: floorTickPDA,
      //     latestCheckpoint: latestCheckpointPDA,
      //     newCheckpoint: newCheckpointPDA,
      //     auctionSteps: stepsPDA,
      //     bidderCurrencyAccount: bidderCurrencyAccount,
      //     currencyVault: currencyVaultPDA,
      //   })
      //   .signers([bidder])
      //   .rpc();

      // console.log("Submit bid tx:", tx);

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

  // --- Two-bidder partial fill test with 4 steps (each 25% of supply) ---
  describe("exit_partially_filled_bid — two bidders, 4 steps", () => {
    let auctionMint: PublicKey;
    let auctionCurrencyMint: PublicKey;
    let auctionPDA: PublicKey;
    let stepsPDA: PublicKey;
    let tokenVaultPDA: PublicKey;
    let currencyVaultPDA: PublicKey;
    let startTime: number;
    let endTime: number;
    let claimTime: number;

    const bidderA = Keypair.generate();
    const bidderB = Keypair.generate();
    let bidderACurrencyAccount: PublicKey;
    let bidderBCurrencyAccount: PublicKey;
    let bidderATokenAccount: PublicKey;
    let bidderBTokenAccount: PublicKey;

    // Auction config: 4 steps, each covering 25% of supply over equal duration
    // total_supply = 10_000, each step emits 2_500 tokens worth of MPS
    // MPS = 10_000_000 total, 4 steps of 2_500_000 each, duration 25s each = 100s total
    const testTotalSupply = 10_000;
    const testFloorPrice = new BN(100);
    const testTickSpacing = 10;
    const testRequiredCurrencyRaised = 50_000;

    // BidderA bids at price 20 (in Q64), BidderB bids at price 10 (in Q64)
    // When both bids are in, clearing price will rise.
    // If clearing settles at bidderB's price, bidderB is partially filled.
    const priceA = new BN(20).shln(64); // 20.0 Q64
    const priceB = new BN(10).shln(64); // 10.0 Q64
    const bidAmountA = 50_000;
    const bidAmountB = 50_000;

    let bidASubmitTime: number;
    let bidBSubmitTime: number;

    before(async () => {
      // Airdrop to bidders
      const sigA = await connection.requestAirdrop(
        bidderA.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      const sigB = await connection.requestAirdrop(
        bidderB.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sigA);
      await connection.confirmTransaction(sigB);

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
        testTotalSupply
      );

      // Bidder currency accounts
      bidderACurrencyAccount = await createAccount(
        connection,
        bidderA,
        auctionCurrencyMint,
        bidderA.publicKey
      );
      bidderBCurrencyAccount = await createAccount(
        connection,
        bidderB,
        auctionCurrencyMint,
        bidderB.publicKey
      );
      await mintTo(
        connection,
        creator,
        auctionCurrencyMint,
        bidderACurrencyAccount,
        creator,
        100_000
      );
      await mintTo(
        connection,
        creator,
        auctionCurrencyMint,
        bidderBCurrencyAccount,
        creator,
        100_000
      );

      // Bidder token accounts (for claim)
      bidderATokenAccount = await createAccount(
        connection,
        bidderA,
        auctionMint,
        bidderA.publicKey
      );
      bidderBTokenAccount = await createAccount(
        connection,
        bidderB,
        auctionMint,
        bidderB.publicKey
      );

      // Initialize auction: 4 steps, each 25s with mps = 2_500_000
      const now = Math.floor(Date.now() / 1000);
      startTime = now + 2;
      endTime = startTime + 100; // 4 steps of 25s = 100s
      claimTime = endTime;

      const steps = [
        { mps: 100_000, duration: 25 },
        { mps: 100_000, duration: 25 },
        { mps: 100_000, duration: 25 },
        { mps: 100_000, duration: 25 },
      ];

      [auctionPDA] = findAuctionPDA(auctionMint, creator.publicKey);
      [stepsPDA] = findStepsPDA(auctionPDA);
      [tokenVaultPDA] = findTokenVaultPDA(auctionPDA);
      [currencyVaultPDA] = findCurrencyVaultPDA(auctionPDA);

      await program.methods
        .initializeAuction({
          totalSupply: new BN(testTotalSupply),
          startTime: new BN(startTime),
          endTime: new BN(endTime),
          claimTime: new BN(claimTime),
          tickSpacing: new BN(testTickSpacing),
          floorPrice: testFloorPrice,
          requiredCurrencyRaised: new BN(testRequiredCurrencyRaised),
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

      console.log("4-step auction initialized");
    });

    it("bidderA submits bid at price 20", async () => {
      await sleep(3000);

      const slot = await connection.getSlot();
      const now = await connection.getBlockTime(slot);
      if (!now || now < startTime) throw new Error("Clock hasn't advanced past start_time");
      bidASubmitTime = now;

      const [bidPDA] = findBidPDA(auctionPDA, 0);
      const [tickPDA] = findTickPDA(auctionPDA, priceA);
      const [floorTickPDA] = findFloorTickPDA(auctionPDA, testFloorPrice);
      const [latestCheckpointPDA] = findCheckpointPDA(auctionPDA, startTime);
      const [newCheckpointPDA] = findCheckpointPDA(auctionPDA, now);

      await program.methods
        .submitBid({
          maxPrice: priceA,
          amount: new BN(bidAmountA),
          prevTickPrice: testFloorPrice,
          now: new BN(now),
        })
        .accountsPartial({
          bidder: bidderA.publicKey,
          auction: auctionPDA,
          bid: bidPDA,
          tick: tickPDA,
          prevTick: floorTickPDA,
          latestCheckpoint: latestCheckpointPDA,
          newCheckpoint: newCheckpointPDA,
          auctionSteps: stepsPDA,
          bidderCurrencyAccount: bidderACurrencyAccount,
          currencyVault: currencyVaultPDA,
        })
        .signers([bidderA])
        .rpc();

      console.log("BidderA submitted at price 20, time:", now);
      const auction = await program.account.auction.fetch(auctionPDA);
      console.log("Clearing price after bidA:", auction.clearingPrice.toString());
    });

    it("bidderB submits bid at price 10", async () => {
      await sleep(2000);
      const slot = await connection.getSlot();
      const now = await connection.getBlockTime(slot);
      if (!now) throw new Error("Cannot get block time");
      bidBSubmitTime = now;

      // BidderB bids at price 10 — tick 20 (bidderA's) is the prev tick for insertion
      const [bidPDA] = findBidPDA(auctionPDA, 1);
      const [tickPDA] = findTickPDA(auctionPDA, priceB);
      const [prevTickPDA] = findTickPDA(auctionPDA, testFloorPrice);
      const [latestCheckpointPDA] = findCheckpointPDA(auctionPDA, bidASubmitTime);
      const [newCheckpointPDA] = findCheckpointPDA(auctionPDA, now);

      await program.methods
        .submitBid({
          maxPrice: priceB,
          amount: new BN(bidAmountB),
          prevTickPrice: testFloorPrice,
          now: new BN(now),
        })
        .accountsPartial({
          bidder: bidderB.publicKey,
          auction: auctionPDA,
          bid: bidPDA,
          tick: tickPDA,
          prevTick: prevTickPDA,
          latestCheckpoint: latestCheckpointPDA,
          newCheckpoint: newCheckpointPDA,
          auctionSteps: stepsPDA,
          bidderCurrencyAccount: bidderBCurrencyAccount,
          currencyVault: currencyVaultPDA,
        })
        .signers([bidderB])
        .rpc();

      console.log("BidderB submitted at price 10, time:", now);
      const auction = await program.account.auction.fetch(auctionPDA);
      console.log("Clearing price after bidB:", auction.clearingPrice.toString());
    });

    it("creates final checkpoint after auction ends", async () => {
      const auction = await program.account.auction.fetch(auctionPDA);
      const endT = auction.endTime.toNumber();

      let now: number;
      do {
        await sleep(2000);
        const slot = await connection.getSlot();
        now = (await connection.getBlockTime(slot))!;
      } while (now < endT);

      const lastCpTime = auction.lastCheckpointedTime.toNumber();
      const [latestCheckpointPDA] = findCheckpointPDA(auctionPDA, lastCpTime);
      const [newCheckpointPDA] = findCheckpointPDA(auctionPDA, now);

      await program.methods
        .checkpoint({ now: new BN(now) })
        .accountsPartial({
          payer: creator.publicKey,
          auction: auctionPDA,
          latestCheckpoint: latestCheckpointPDA,
          newCheckpoint: newCheckpointPDA,
          auctionSteps: stepsPDA,
        })
        .rpc();

      const auctionAfter = await program.account.auction.fetch(auctionPDA);
      console.log("Graduated:", auctionAfter.graduated);
      console.log("Final clearing price:", auctionAfter.clearingPrice.toString());

      const finalCp = await program.account.checkpoint.fetch(newCheckpointPDA);
      console.log("Final checkpoint clearing:", finalCp.clearingPrice.toString());
      console.log("Final checkpoint cumMps:", finalCp.cumulativeMps);
    });

    it("exits bidderA (fully filled, above clearing)", async () => {
      const auction = await program.account.auction.fetch(auctionPDA);
      const bid = await program.account.bid.fetch(findBidPDA(auctionPDA, 0)[0]);

      const finalCpTime = auction.lastCheckpointedTime.toNumber();
      const [bidPDA] = findBidPDA(auctionPDA, 0);
      const [startCheckpointPDA] = findCheckpointPDA(auctionPDA, bid.startTime.toNumber());
      const [finalCheckpointPDA] = findCheckpointPDA(auctionPDA, finalCpTime);

      // BidderA's price (20) should be > clearing price → fully filled → use exit_bid
      const finalCp = await program.account.checkpoint.fetch(finalCheckpointPDA);
      console.log("BidA max_price:", bid.maxPrice.toString());
      console.log("Final clearing:", finalCp.clearingPrice.toString());

      if (bid.maxPrice.gt(finalCp.clearingPrice)) {
        await program.methods
          .exitBid()
          .accountsPartial({
            auction: auctionPDA,
            bid: bidPDA,
            startCheckpoint: startCheckpointPDA,
            finalCheckpoint: finalCheckpointPDA,
            currencyVault: currencyVaultPDA,
            bidOwnerCurrencyAccount: bidderACurrencyAccount,
          })
          .rpc();

        const bidAfter = await program.account.bid.fetch(bidPDA);
        console.log("BidderA tokens filled:", bidAfter.tokensFilled.toNumber());
        expect(bidAfter.exitedTime.toNumber()).to.be.greaterThan(0);
      } else {
        console.log("BidderA at or below clearing — will use partial exit");
      }
    });

    it("exits bidderB (partially filled at clearing price)", async () => {
      const auction = await program.account.auction.fetch(auctionPDA);
      const bid = await program.account.bid.fetch(findBidPDA(auctionPDA, 1)[0]);
      const finalCpTime = auction.lastCheckpointedTime.toNumber();

      const [bidPDA] = findBidPDA(auctionPDA, 1);
      const [startCheckpointPDA] = findCheckpointPDA(auctionPDA, bid.startTime.toNumber());
      const [finalCheckpointPDA] = findCheckpointPDA(auctionPDA, finalCpTime);
      const finalCp = await program.account.checkpoint.fetch(finalCheckpointPDA);

      console.log("BidB max_price:", bid.maxPrice.toString());
      console.log("Final clearing:", finalCp.clearingPrice.toString());

      if (bid.maxPrice.eq(finalCp.clearingPrice)) {
        // Partially filled at clearing price — end-of-auction case
        // We need: start_checkpoint, last_fully_filled_checkpoint, next_of_last_fully_filled,
        //          upper_checkpoint (= final), tick, no outbid_checkpoint

        // Find the last checkpoint where clearing < bid.max_price.
        // This is the checkpoint at bid's start time (clearing was lower then).
        // Walk the checkpoint list to find it.
        const startCp = await program.account.checkpoint.fetch(startCheckpointPDA);

        // If start checkpoint's clearing < bid.max_price, it's our last_fully_filled.
        // The next checkpoint after it should have clearing >= bid.max_price.
        let lastFFTime = startCp.timestamp.toNumber();
        let lastFFCp = startCp;

        // Walk forward to find the actual last fully filled checkpoint
        let currentCpTime = lastFFTime;
        let currentCp = lastFFCp;
        const MAX_TS = new BN("9223372036854775807");
        while (!currentCp.nextTimestamp.eq(MAX_TS)) {
          const nextTime = currentCp.nextTimestamp.toNumber();
          const [nextPDA] = findCheckpointPDA(auctionPDA, nextTime);
          const nextCp = await program.account.checkpoint.fetch(nextPDA);
          if (nextCp.clearingPrice.lt(bid.maxPrice)) {
            lastFFTime = nextTime;
            lastFFCp = nextCp;
            currentCpTime = nextTime;
            currentCp = nextCp;
          } else {
            break;
          }
        }

        const [lastFFPDA] = findCheckpointPDA(auctionPDA, lastFFTime);
        const nextFFTime = lastFFCp.nextTimestamp.toNumber();
        const [nextFFPDA] = findCheckpointPDA(auctionPDA, nextFFTime);

        const [tickPDA] = findTickPDA(auctionPDA, priceB);

        console.log("Using last_fully_filled checkpoint at:", lastFFTime);
        console.log("next_of_last_fully_filled at:", nextFFTime);

        await program.methods
          .exitPartiallyFilledBid()
          .accountsPartial({
            auction: auctionPDA,
            bid: bidPDA,
            startCheckpoint: startCheckpointPDA,
            lastFullyFilledCheckpoint: lastFFPDA,
            nextOfLastFullyFilled: nextFFPDA,
            upperCheckpoint: finalCheckpointPDA,
            outbidCheckpoint: null,
            tick: tickPDA,
            currencyVault: currencyVaultPDA,
            bidOwnerCurrencyAccount: bidderBCurrencyAccount,
          })
          .rpc();

        const bidAfter = await program.account.bid.fetch(bidPDA);
        console.log("BidderB tokens filled:", bidAfter.tokensFilled.toNumber());
        console.log("BidderB exited at:", bidAfter.exitedTime.toNumber());
        expect(bidAfter.exitedTime.toNumber()).to.be.greaterThan(0);
        expect(bidAfter.tokensFilled.toNumber()).to.be.greaterThan(0);
      } else if (bid.maxPrice.gt(finalCp.clearingPrice)) {
        // Fully filled — use regular exit
        console.log("BidB is fully filled, using exit_bid instead");
        await program.methods
          .exitBid()
          .accountsPartial({
            auction: auctionPDA,
            bid: bidPDA,
            startCheckpoint: startCheckpointPDA,
            finalCheckpoint: finalCheckpointPDA,
            currencyVault: currencyVaultPDA,
            bidOwnerCurrencyAccount: bidderBCurrencyAccount,
          })
          .rpc();

        const bidAfter = await program.account.bid.fetch(bidPDA);
        console.log("BidderB tokens filled:", bidAfter.tokensFilled.toNumber());
        expect(bidAfter.exitedTime.toNumber()).to.be.greaterThan(0);
      } else {
        console.log("BidB is below clearing — full refund via exit_bid");
      }
    });

    it("both bidders claim tokens", async () => {
      const bidA = await program.account.bid.fetch(findBidPDA(auctionPDA, 0)[0]);
      const bidB = await program.account.bid.fetch(findBidPDA(auctionPDA, 1)[0]);

      if (bidA.tokensFilled.toNumber() > 0) {
        await program.methods
          .claimTokens()
          .accountsPartial({
            auction: auctionPDA,
            bid: findBidPDA(auctionPDA, 0)[0],
            tokenVault: tokenVaultPDA,
            bidOwnerTokenAccount: bidderATokenAccount,
          })
          .rpc();

        const tokenAccA = await getAccount(connection, bidderATokenAccount);
        console.log("BidderA claimed tokens:", Number(tokenAccA.amount));
        expect(Number(tokenAccA.amount)).to.be.greaterThan(0);
      }

      if (bidB.tokensFilled.toNumber() > 0) {
        await program.methods
          .claimTokens()
          .accountsPartial({
            auction: auctionPDA,
            bid: findBidPDA(auctionPDA, 1)[0],
            tokenVault: tokenVaultPDA,
            bidOwnerTokenAccount: bidderBTokenAccount,
          })
          .rpc();

        const tokenAccB = await getAccount(connection, bidderBTokenAccount);
        console.log("BidderB claimed tokens:", Number(tokenAccB.amount));
        expect(Number(tokenAccB.amount)).to.be.greaterThan(0);
      }

      // Log total tokens distributed
      const vaultAcc = await getAccount(connection, tokenVaultPDA);
      console.log("Tokens remaining in vault:", Number(vaultAcc.amount));
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
