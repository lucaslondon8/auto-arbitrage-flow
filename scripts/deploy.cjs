// scripts/deploy.cjs

const { ethers, run } = require("hardhat");
const dotenv = require("dotenv");

dotenv.config();

async function main() {
  const provider = process.env.AAVE_ADDRESSES_PROVIDER ||
    "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";

  console.log("Deploying FlashArbitrageur with AddressesProvider:", provider);

  const Factory = await ethers.getContractFactory("FlashArbitrageur");
  const contract = await Factory.deploy(provider);
  
  // In ethers v6, waitForDeployment is not a function. The deployment is awaited on the line above.
  // We can get the deployed address directly.
  const address = await contract.getAddress();
  console.log("FlashArbitrageur deployed at:", address);

  // Optional: Wait for a few confirmations before verifying
  console.log("Waiting for block confirmations...");
  const tx = contract.deploymentTransaction();
  await tx.wait(5); 
  console.log("5 confirmations received.");


  if (process.env.POLYGONSCAN_API_KEY) {
    console.log("Attempting verification on Polygonscan...");
    try {
      await run("verify:verify", {
        address,
        constructorArguments: [provider],
      });
      console.log("Verification successful");
    } catch (err) {
      // This is the corrected line
      console.log("Verification skipped/failed:", err.message || err);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
