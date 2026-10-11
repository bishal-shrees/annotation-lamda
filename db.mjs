import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '.env');

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  } else if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (_) {
}

let cachedClient = null;

/**
 * Connects to the MongoDB cluster once and caches the connection.
 */
export async function getClusterClient() {
  if (!cachedClient) {
    const uri = process.env.CLUSTER_URI;
    if (!uri) throw new Error("CLUSTER_URI must be configured in environment");
    console.log("Initializing new MongoDB cluster connection...");
    cachedClient = new MongoClient(uri);
    await cachedClient.connect();
  }
  return cachedClient;
}

/**
 * Gracefully closes the cluster connection.
 */
export async function closeClusterClient() {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
    console.log("MongoDB cluster connection closed.");
  }
}

/**
 * Fetches all active subdomains from the Super Admin database.
 */
export async function getActiveSubdomains() {
  const client = await getClusterClient();
  const superDbName = process.env.SUPER_DB_NAME || "Grinds360-Superadmin-Sandbox";
  const db = client.db(superDbName);
  
  const clients = await db.collection("clients")
    .find({ isDeleted: false }, { projection: { subdomain: 1 } })
    .toArray();
  
  return clients.map(c => c.subdomain).filter(Boolean);
}

/**
 * A reusable wrapper that provides the specific tenant DB instance.
 * Automatically aligns with the annotation-service naming convention:
 * - production: saas-${subdomain}
 * - uat: saas-${subdomain}-uat
 * - sandbox/development: saas-${subdomain}-sandbox
 */
export async function withTenantDb(subdomain, callback) {
  const client = await getClusterClient();
  
  const env = (process.env.NODE_ENV ||'').toLowerCase().trim();
  const rawSub = String(subdomain || "").toLowerCase().trim();
  
  let tenantDbName;
  if (process.env.TENANT_DB_NAME_OVERRIDE) {
    tenantDbName = process.env.TENANT_DB_NAME_OVERRIDE.replace("{subdomain}", rawSub);
  } else if (env === "production" || env === "prod") {
    tenantDbName = `saas-${rawSub}`;
  } else if (env === "uat") {
    tenantDbName = `saas-${rawSub}-uat`;
  } else {
    tenantDbName = `saas-${rawSub}-sandbox`;
  }

  const tenantDb = client.db(tenantDbName);
  return await callback(tenantDb);
}

