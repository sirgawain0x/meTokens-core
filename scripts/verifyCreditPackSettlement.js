/**
 * One-off Basescan verification for CreditPackSettlement.
 * Usage: node scripts/verifyCreditPackSettlement.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const CONTRACT = "0x03e8a588CD5873796b5C5EF6A96e7EE7704d1FF9";
const BUILD_INFO = path.join(
  __dirname,
  "..",
  "artifacts/build-info/d0e8fd5721dff7838d0b85bcefcfeb6c.json"
);
const CONSTRUCTOR_TYPES = ["address", "address", "address", "address"];
const CONSTRUCTOR_VALUES = [
  "0xba5502db2aC2cBff189965e991C07109B14eB3f5",
  "0xecb695544a3d2a64d579b3828f3f60f6932f4846",
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "0xd4b3f4d2c44Feba751F30e19D7e1047A29eE085d",
];

async function etherscanV2Request(query, body = {}) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey)
    throw new Error("ETHERSCAN_API_KEY missing in packages/metokens/core/.env");

  const qs = new URLSearchParams({
    chainid: "8453",
    apikey: apiKey,
    ...query,
  });
  const res = await fetch(`https://api.etherscan.io/v2/api?${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  return res.json();
}

async function main() {
  const buildInfo = JSON.parse(fs.readFileSync(BUILD_INFO, "utf8"));
  const constructorArguments = ethers.utils.defaultAbiCoder
    .encode(CONSTRUCTOR_TYPES, CONSTRUCTOR_VALUES)
    .slice(2);

  console.log("Submitting verification for", CONTRACT);
  const submit = await etherscanV2Request(
    { module: "contract", action: "verifysourcecode" },
    {
      contractaddress: CONTRACT,
      codeformat: "solidity-standard-json-input",
      contractname: "contracts/CreditPackSettlement.sol:CreditPackSettlement",
      compilerversion: `v${buildInfo.solcLongVersion}`,
      sourceCode: JSON.stringify(buildInfo.input),
      constructorArguments,
      licenseType: "3",
    }
  );

  console.log("Submit response:", submit);
  if (submit.status !== "1") {
    throw new Error(
      submit.result || submit.message || "Verification submit failed"
    );
  }

  const guid = submit.result;
  console.log("GUID:", guid);

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await etherscanV2Request({
      module: "contract",
      action: "checkverifystatus",
      guid,
    });
    console.log(`Poll ${i + 1}:`, status.result || status.message);
    if (status.result === "Pass - Verified") {
      console.log(
        "\nVerified: https://basescan.org/address/" + CONTRACT + "#code"
      );
      return;
    }
    if (typeof status.result === "string" && status.result.startsWith("Fail")) {
      throw new Error(status.result);
    }
  }

  throw new Error("Verification still pending — check Basescan manually.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
