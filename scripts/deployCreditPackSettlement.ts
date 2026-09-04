import { ethers, network, run } from "hardhat";
import { CreditPackSettlement } from "../artifacts/types";

/**
 * Deploy CreditPackSettlement on Base.
 *
 * The settlement contract is wired to the live meTokens Diamond and the
 * CRTVAI meToken (hub 2, USDC-backed). Constructor args are the four
 * addresses the contract needs to settle a pack atomically:
 *   foundry  = meTokens Diamond (FoundryFacet lives here)
 *   meToken  = CRTVAI meToken
 *   asset    = hub 2 connector asset (USDC)
 *   vault    = hub 2 vault (holds the USDC)
 *
 * Usage:
 *   cd packages/metokens/core
 *   yarn hardhat run scripts/deployCreditPackSettlement.ts --network base
 *
 * Requires PRIVATE_KEY (or MNEMONIC) + ALCHEMY_API_KEY in .env.
 */

// Live Base addresses (from deployments/metokens/base.json + subgraph).
const DIAMOND = "0xba5502db2aC2cBff189965e991C07109B14eB3f5";
const CRTVAI_METOKEN = "0xecb695544a3d2a64d579b3828f3f60f6932f4846";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // hub 2 asset
const HUB2_VAULT = "0xd4b3f4d2c44Feba751F30e19D7e1047A29eE085d"; // hub 2 vault

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying CreditPackSettlement on", network.name);
  console.log("Deployer:", await deployer.getAddress());

  const settlement = (await (
    await ethers.getContractFactory("CreditPackSettlement")
  ).deploy(DIAMOND, CRTVAI_METOKEN, USDC, HUB2_VAULT)) as CreditPackSettlement;

  await settlement.deployed();
  console.log("\nCreditPackSettlement deployed at:", settlement.address);

  console.log("\nConstructor args (for verification):");
  console.log(JSON.stringify([DIAMOND, CRTVAI_METOKEN, USDC, HUB2_VAULT]));

  // Attempt verification (Base uses Basescan; the etherscan plugin's apiKey
  // must be set to a Basescan key in .env).
  try {
    await run("verify:verify", {
      address: settlement.address,
      constructorArguments: [DIAMOND, CRTVAI_METOKEN, USDC, HUB2_VAULT],
    });
    console.log("Verified on Basescan.");
  } catch (e) {
    console.log("Verification skipped/failed:", (e as Error).message);
  }

  console.log(
    "\nNext: set NEXT_PUBLIC_CREDIT_PACK_SETTLEMENT_ADDRESS =",
    settlement.address
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
