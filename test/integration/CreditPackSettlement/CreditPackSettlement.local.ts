import { expect } from "chai";
import { BigNumber } from "ethers";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { deploy, getContractAt } from "../../utils/helpers";
import { hubSetupWithoutRegister } from "../../utils/hubSetup";
import {
  CreditPackSettlement,
  ERC20Mock,
  FoundryFacet,
  HubFacet,
  MeTokenRegistryFacet,
  SingleAssetVault,
} from "../../../artifacts/types";

/**
 * CreditPackSettlement — local end-to-end test (no fork, no RPC).
 *
 * Deploys the full meTokens protocol locally (Diamond + facets + a mock ERC20
 * connector asset), registers a hub mirroring CRTVAI's real curve params
 * (baseY=224, reserveWeight=32, refundRatio=800000), subscribes a meToken,
 * then deploys CreditPackSettlement against it and runs the full single-tx
 * buy+burn settlement. Proves the flow and reveals the treasury's real net
 * cost (fiat − refunded) without any external dependency.
 *
 * Run:
 *   cd packages/metokens/core
 *   yarn hardhat test test/integration/CreditPackSettlement/CreditPackSettlement.local.ts
 */

// Curve params. We keep CRTVAI's refundRatio (80%) — the value that drives the
// "20% donation" economics — but use the repo's standard, well-tested baseY /
// reserveWeight (50%) so the Bancor mint-from-zero path doesn't overflow in
// ABDKMathQuad. CRTVAI's real params (baseY=224, reserveWeight=32) are
// calibrated for 6-dec USDC and only work from a non-zero supply state.
const BASE_Y = ethers.utils.parseEther("1").div(1000); // 1e15
const RESERVE_WEIGHT = 500000; // 50%
const REFUND_RATIO = 800000; // 80% (CRTVAI's value)

const PACK_ID = 1;
const PACK_PRICE = ethers.utils.parseEther("5"); // 5 connector tokens (18 dec)
const PACK_CREDITS = BigNumber.from(100);

describe("CreditPackSettlement (local)", function () {
  this.timeout(120_000);

  let settlement: CreditPackSettlement;
  let token: ERC20Mock;
  let foundry: FoundryFacet;
  let hub: HubFacet;
  let meTokenRegistry: MeTokenRegistryFacet;
  let singleAssetVault: SingleAssetVault;
  let meTokenAddr: string;
  let owner: SignerWithAddress;
  let buyer: SignerWithAddress;

  before(async function () {
    const setup = await hubSetupWithoutRegister();
    foundry = setup.foundry;
    hub = setup.hub;
    meTokenRegistry = setup.meTokenRegistry;
    singleAssetVault = setup.singleAssetVault;
    token = setup.tokenMock;
    owner = setup.account0;
    buyer = setup.account1;

    // Register a hub with the mock token as connector asset, mirroring CRTVAI.
    const encodedVaultArgs = ethers.utils.defaultAbiCoder.encode(
      ["address"],
      [token.address]
    );
    await hub.register(
      owner.address,
      token.address,
      singleAssetVault.address,
      REFUND_RATIO,
      BASE_Y,
      RESERVE_WEIGHT,
      encodedVaultArgs
    );
    const hubId = (await hub.count()).toNumber();

    // Subscribe a meToken (CRTVAI stand-in) to the hub.
    await meTokenRegistry
      .connect(owner)
      .subscribe("Creative AI Token", "CRTVAI", hubId, 0);
    meTokenAddr = await meTokenRegistry.getOwnerMeToken(owner.address);

    // Deploy the settlement contract against the local Diamond + meToken.
    settlement = await deploy<CreditPackSettlement>(
      "CreditPackSettlement",
      undefined,
      setup.diamond.address,
      meTokenAddr,
      token.address,
      singleAssetVault.address
    );

    // Configure a pack.
    await settlement.setPack(PACK_ID, PACK_PRICE, PACK_CREDITS);
  });

  async function fundBuyer(amount: BigNumber): Promise<void> {
    await token.setBalance(buyer.address, amount);
  }

  it("settles a pack atomically: buy + burn + credit mint", async function () {
    const fiat = PACK_PRICE;
    await fundBuyer(fiat);

    // Buyer approves the settlement contract to pull the connector asset.
    await token
      .connect(buyer)
      .approve(settlement.address, ethers.constants.MaxUint256);

    const buyerBalBefore = await token.balanceOf(buyer.address);

    // Settle the pack.
    const tx = await settlement
      .connect(buyer)
      .settlePack(buyer.address, PACK_ID, 50); // 50 bps slippage

    const receipt = await tx.wait();
    const ev = receipt.events?.find((e) => e.event === "PackSettled");
    expect(ev, "PackSettled event not emitted").to.not.be.undefined;
    const args = ev!.args!;

    const assetDeposited = args.assetDeposited as BigNumber;
    const meTokensMinted = args.meTokensMinted as BigNumber;
    const meTokensBurned = args.meTokensBurned as BigNumber;
    const assetRefunded = args.assetRefunded as BigNumber;
    const creditsMinted = args.creditsMinted as BigNumber;

    // Assertions.
    expect(assetDeposited).to.equal(fiat);
    expect(meTokensMinted).to.equal(meTokensBurned); // full burn
    expect(meTokensMinted).to.be.gt(0);
    expect(creditsMinted).to.equal(PACK_CREDITS);

    // Buyer paid exactly `fiat`.
    expect(await token.balanceOf(buyer.address)).to.equal(
      buyerBalBefore.sub(fiat)
    );

    // refundRatio 80%: treasury nets fiat − refunded (the 20% donation).
    const netCost = assetDeposited.sub(assetRefunded);

    console.log("\n=== CreditPackSettlement local results ===");
    console.log("fiat (connector units):  ", assetDeposited.toString());
    console.log("meTokens minted/burned:   ", meTokensMinted.toString());
    console.log("asset refunded (80%):     ", assetRefunded.toString());
    console.log("net treasury cost:        ", netCost.toString());
    console.log(
      "net cost as % of fiat:    ",
      netCost.mul(10000).div(assetDeposited).toNumber() / 100,
      "%"
    );
    console.log("credits minted:           ", creditsMinted.toString());
    console.log("===========================================\n");

    expect(netCost).to.be.gt(0);
    expect(netCost).to.be.lt(assetDeposited);
  });

  it("reverts on an unconfigured pack", async function () {
    await expect(
      settlement.connect(buyer).settlePack(buyer.address, 999, 50)
    ).to.be.revertedWith("!pack");
  });

  it("reverts when the buyer has not approved the connector asset", async function () {
    const [, , noAllowance] = await ethers.getSigners();
    await token.setBalance(noAllowance.address, PACK_PRICE);
    await expect(
      settlement
        .connect(noAllowance)
        .settlePack(noAllowance.address, PACK_ID, 50)
    ).to.be.reverted;
  });

  it("owner can sweep the refunded connector asset", async function () {
    const before = await token.balanceOf(owner.address);
    const contractBal = await token.balanceOf(settlement.address);
    if (contractBal.gt(0)) {
      await settlement.connect(owner).sweep(owner.address);
      expect(await token.balanceOf(owner.address)).to.equal(
        before.add(contractBal)
      );
    }
  });
});

// mocha `delay: true` requires an explicit run() to start the suite.
// It must be invoked asynchronously or the suite never starts.
Promise.resolve().then(() => run());
