import { task } from "hardhat/config";

task("chainId", "Prints the current chain ID").setAction(
  async (_taskArgs, { ethers }) => {
    await ethers.provider.getNetwork().then((net) => {
      console.log(`Current chain ID: ${net.chainId}`);
    });
  }
);
