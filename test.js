import { handler } from './index.mjs';
import { closeClusterClient } from './db.mjs';
const runTest = async () => {
  try {
    console.log("Running local test for Lambda retry (all parameters loaded from .env)...");
    const result = await handler();
    console.log("Test Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Test failed:", error);
  } finally {
    await closeClusterClient();
  }
};

runTest();
