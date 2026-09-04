import { ethers, network } from "hardhat";
import { CreditPackSettlement } from "../artifacts/types";

/**
 * Register the three retail credit packs on the deployed CreditPackSettlement
 * contract (Base).
 *
 * Packs (1 credit = $0.10):
 *   pack 0: $20  -> 200 credits
 *   pack 1: $50  -> 500 credits
 *   pack 2: $100 -> 1000 credits
 *
 * `setPack` is `onlyOwner`, so this must be run from the deployer/owner key
 * (0x1fde40a4046eda0ca0539dd6c77abf8933b94260).
 *
 * Usage:
 *   cd packages/metokens/core
 *   yarn hardhat run scripts/setPacks.ts --network base
 *
 * Requires PRIVATE_KEY (or MNEMONIC) + ALCHEMY_API_KEY in .env.
 */

const SETTLEMENT = "0x03e8a588CD5873796b5C5EF6A96e7EE7704d1FF9";

/** Alchemy can reject back-to-back sends for delegated accounts. */
const TX_CONFIRMATIONS = 1;
const DELAY_MS_BETWEEN_PACKS = 3000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// packId -> [fiatAmount (USDC 6-dec), credits]
const PACKS: Array<[number, number, number]> = [
  [0, 20_000_000, 200],
  [1, 50_000_000, 500],
  [2, 100_000_000, 1000],
];

async function main() {
  const [signer] = await ethers.getSigners();
  const signerAddress = await signer.getAddress();
  console.log("Registering credit packs on", network.name);
  console.log("Settlement contract:", SETTLEMENT);
  console.log("Signer (must be owner):", signerAddress);

  const settlement = (await ethers.getContractAt(
    "CreditPackSettlement",
    SETTLEMENT
  )) as CreditPackSettlement;

  const owner = await settlement.owner();
  console.log("Contract owner:", owner);
  if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
      `Signer ${signerAddress} is not the owner (${owner}). Run from the owner key.`
    );
  }

  for (const [packId, fiatAmount, credits] of PACKS) {
    const currentPrice = await settlement.packPrice(packId);
    const currentCredits = await settlement.packCredits(packId);
    console.log(
      `\npack ${packId}: current price=${currentPrice.toString()} credits=${currentCredits.toString()}`
    );

    if (currentPrice.eq(fiatAmount) && currentCredits.eq(credits)) {
      console.log(`  already set — skipping`);
      continue;
    }

    console.log(
      `  setting price=${fiatAmount} ($${
        fiatAmount / 1_000_000
      }) credits=${credits}...`
    );
    const tx = await settlement.setPack(packId, fiatAmount, credits);
    const receipt = await tx.wait(TX_CONFIRMATIONS);
    console.log(
      `  ✅ setPack(${packId}) confirmed in tx ${receipt.transactionHash}`
    );
    await sleep(DELAY_MS_BETWEEN_PACKS);
  }

  console.log("\nDone. Final on-chain state:");
  for (const [packId] of PACKS) {
    const price = await settlement.packPrice(packId);
    const credits = await settlement.packCredits(packId);
    console.log(
      `  pack ${packId}: $${
        price.toNumber() / 1_000_000
      } -> ${credits.toString()} credits`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
