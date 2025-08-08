/** @type import('hardhat/config').HardhatUserConfig */

// Load environment variables from .env file
require('dotenv').config();

// Retrieve variables from .env
const polygonRpcUrl = process.env.POLYGON_RPC_URL;
const privateKey = process.env.PRIVATE_KEY;

// A check to make sure the variables are set
if (!polygonRpcUrl || !privateKey) {
  throw new Error("Please set your POLYGON_RPC_URL and PRIVATE_KEY in your .env file");
}

module.exports = {
  solidity: "0.8.28",
  networks: {
    polygon: {
      url: polygonRpcUrl,
      accounts: [privateKey],
    },
    // You can add other networks here in the future
  },
};
