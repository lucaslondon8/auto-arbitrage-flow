<<<<<<< HEAD
// Correctly import Hardhat and other modules using the 'import' syntax
import hre from "hardhat";
import * as dotenv from "dotenv";
const { ethers, run } = hre;

=======
import { ethers, run } from "hardhat";
import * as dotenv from "dotenv";
>>>>>>> d49739900c2aed42ab65207c9df1779b44680482
dotenv.config();

async function main() {
  const provider = process.env.AAVE_ADDRESSES_PROVIDER ||
    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb"; // Aave V3 AddressesProvider (Polygon)

  console.log("Deploying FlashArbitrageur with AddressesProvider:", provider);

  const Factory = await ethers.getContractFactory("FlashArbitrageur");
  const contract = await Factory.deploy(provider);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("FlashArbitrageur deployed at:", address);

  if (process.env.POLYGONSCAN_API_KEY) {
    console.log("Attempting verification on Polygonscan...");
    try {
      await run("verify:verify", {
        address,
        constructorArguments: [provider],
      });
      console.log("Verification successful");
<<<<<<< HEAD
    } catch (err) {
      console.log("Verification skipped/failed:", (err as any)?.message || err);
=======
    } catch (err: any) {
      console.log("Verification skipped/failed:", err?.message || err);
>>>>>>> d49739900c2aed42ab65207c9df1779b44680482
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
