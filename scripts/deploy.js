const { ethers } = require("hardhat");

async function main() {
  console.log("Deploying FlashArbitrageur to Polygon mainnet...");

  // Aave V3 PoolAddressesProvider on Polygon mainnet
  const POLYGON_POOL_ADDRESSES_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";

  // Get the contract factory
  const FlashArbitrageur = await ethers.getContractFactory("FlashArbitrageur");

  // Deploy the contract
  const flashArbitrageur = await FlashArbitrageur.deploy(POLYGON_POOL_ADDRESSES_PROVIDER);

  await flashArbitrageur.waitForDeployment();

  const contractAddress = await flashArbitrageur.getAddress();

  console.log("FlashArbitrageur deployed to:", contractAddress);
  console.log("Transaction hash:", flashArbitrageur.deploymentTransaction().hash);

  // Verify contract on Polygonscan (optional)
  console.log("Waiting for block confirmations...");
  await flashArbitrageur.deploymentTransaction().wait(5);

  console.log("Verifying contract on Polygonscan...");
  try {
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: [POLYGON_POOL_ADDRESSES_PROVIDER],
    });
    console.log("Contract verified successfully");
  } catch (error) {
    console.log("Verification failed:", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });