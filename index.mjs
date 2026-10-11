import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ObjectId } from 'mongodb';
import { getActiveSubdomains, withTenantDb } from './db.mjs';

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
} catch (_) {}

export const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
export const DEFAULT_BATCH_SIZE = parseInt(process.env.BATCH_SIZE || process.env.STATIC_BATCH_SIZE || '20', 10);
export const DEFAULT_CONCURRENCY = parseInt(process.env.CONCURRENCY || process.env.STATIC_CONCURRENCY || '10', 10);


const TOOL_MAP = {
  mcq: { tool: 'mcq', resultKey: 'mcqResult' },
  summary: { tool: 'summary', resultKey: 'summaryResult' },
  flashcard: { tool: 'flashcard', resultKey: 'flashcardResult' },
  flashcards: { tool: 'flashcard', resultKey: 'flashcardResult' },
  mindmap: { tool: 'mindmap', resultKey: 'mindmapResult' },
  explanation: { tool: 'explanation', resultKey: 'explanationResult' },
  explain: { tool: 'explanation', resultKey: 'explanationResult' },
};


function toObjectId(value) {
  if (!value) return null;
  if (typeof value === 'object' && value.constructor && value.constructor.name === 'ObjectId') {
    return value;
  }
  const str = String(value).trim();
  if (ObjectId.isValid(str) && str.length === 24) {
    try {
      return new ObjectId(str);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}


async function processSingleDoc(retryDoc, { genAI, modelName, aiAnalytics, aiResults, subdomain }) {
  const rawFeature = retryDoc.feature;
  const mapping = TOOL_MAP[String(rawFeature).toLowerCase().trim()];
  if (!mapping) {
    console.warn(`[AI Lambda] Unknown feature "${rawFeature}" on doc ${retryDoc._id}`);
    await aiAnalytics.updateOne(
      { _id: retryDoc._id },
      { $set: { isRetried: true, retryStatus: "unsupported_tool", lastRetriedAt: new Date() } }
    );
    return { subdomain, id: retryDoc._id, status: "skipped", reason: `Unsupported tool "${rawFeature}"` };
  }

  const { tool, resultKey } = mapping;
  const promptText = typeof retryDoc.prompt === 'string' ? retryDoc.prompt.trim() : '';

  if (!promptText) {
    console.warn(`[AI Lambda] Missing prompt on doc ${retryDoc._id} (${tool}) - marking abandoned`);
    await aiAnalytics.updateOne(
      { _id: retryDoc._id },
      {
        $set: {
          isRetried: true,
          retryStatus: "missing_content",
          lastRetryError: "No prompt available in analytics record",
          lastRetriedAt: new Date(),
        },
        $inc: { retryCount: 1 },
      }
    );
    return { subdomain, id: retryDoc._id, status: "skipped", reason: "Missing prompt" };
  }

  // Single Source of Truth: Dynamically resolve Gemini parameters from analytics document
  const modelToUse = retryDoc.model || modelName;
  const generationConfigToUse = {
    responseMimeType: "application/json",
    ...(retryDoc.generationConfig || {}),
  };
  if (!generationConfigToUse.responseSchema && retryDoc.responseSchema) {
    generationConfigToUse.responseSchema = retryDoc.responseSchema;
  }

  const modelParams = {
    model: modelToUse,
    generationConfig: generationConfigToUse,
  };
  if (Array.isArray(retryDoc.safetySettings) && retryDoc.safetySettings.length > 0) {
    modelParams.safetySettings = retryDoc.safetySettings;
  }

  const model = genAI.getGenerativeModel(modelParams);

  let generatedData = null;
  let lastError = null;
  let success = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await model.generateContent(promptText);
      const textResult = response.response.text();

      const cleaned = textResult.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
      const parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('AI returned non-object response');
      }
      generatedData = parsed;
      success = true;
      break;
    } catch (error) {
      lastError = error;
      console.warn(`[AI Lambda] Attempt ${attempt} failed for doc ${retryDoc._id} (${tool}):`, error.message);
      if (attempt < 3) await new Promise((res) => setTimeout(res, 2000));
    }
  }

  if (!success || !generatedData) {
    const currentRetries = (retryDoc.retryCount || 0) + 1;
    const shouldAbandon = currentRetries >= 3;
    await aiAnalytics.updateOne(
      { _id: retryDoc._id },
      {
        $set: {
          lastRetryError: lastError ? lastError.message : "Retry failed after 3 attempts",
          lastRetriedAt: new Date(),
          ...(shouldAbandon ? { isRetried: true, retryStatus: "failed_abandoned" } : {})
        },
        $inc: { retryCount: 1 }
      }
    );
    return { subdomain, id: retryDoc._id, status: "failed", error: lastError?.message, tool };
  }

  try {
    const userId = toObjectId(retryDoc.userId);
    const courseId = toObjectId(retryDoc.courseId) || new ObjectId();

    if (!userId) {
      throw new Error(`Cannot save to aiResults: invalid or missing userId on retryDoc ${retryDoc._id}`);
    }

    const role = retryDoc.role === "admin" ? "admin" : "user";
    const now = new Date();

    const insertDoc = {
      userId,
      tool,
      courseId,
      role,
      isPublished: false,
      isDeleted: false,
      [resultKey]: generatedData,
      createdAt: now,
      updatedAt: now,
    };

    if (retryDoc.chapterName) {
      insertDoc.chapterName = retryDoc.chapterName;
    }
    if (tool === 'mcq' && retryDoc.metadata) {
      if (retryDoc.metadata.difficulty) insertDoc.difficulty = retryDoc.metadata.difficulty;
      if (retryDoc.metadata.numQuestions) insertDoc.numQuestions = retryDoc.metadata.numQuestions;
    }

    await aiResults.insertOne(insertDoc);

    await aiAnalytics.updateOne(
      { _id: retryDoc._id },
      {
        $set: {
          isRetried: true,
          retriedAt: now,
          retryStatus: "success",
          lastRetryError: null,
        },
        $inc: { retryCount: 1 }
      }
    );

    return { subdomain, id: retryDoc._id, status: "success", tool };
  } catch (dbError) {
    console.error(`[AI Lambda] DB Save error for ${subdomain} on doc ${retryDoc._id}:`, dbError);
    return { subdomain, id: retryDoc._id, status: "failed", error: dbError.message, tool };
  }
}

// ============================================================================
// AWS Lambda Handler - Multi-Tenant Keyset Cursor Batch Processing Worker
// ============================================================================

export const handler = async (event = {}, context = null) => {
  if (context) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  console.log("Starting AI Direct Retry Lambda: Keyset Cursor Pagination Worker");

  // All configuration loaded strictly from environment variables (.env file)
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY must be configured in environment");

  const modelName = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const batchSize = parseInt(process.env.BATCH_SIZE || process.env.STATIC_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10);
  const concurrency = parseInt(process.env.CONCURRENCY || process.env.STATIC_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10);
  const initialCursor = toObjectId(process.env.CURSOR || process.env.LAST_ID);
  const targetSubdomain = process.env.SUBDOMAIN || process.env.TENANT || process.env.LOCAL_BACKEND_SUBDOMAIN;
  const recordId = process.env.RECORD_ID || process.env.TARGET_ID || null;
  const maxExecutionMs = process.env.MAX_EXECUTION_MS ? parseInt(String(process.env.MAX_EXECUTION_MS), 10) : null;
  const startTime = Date.now();

  const genAI = new GoogleGenerativeAI(apiKey);
  const results = [];

  try {
    const subdomains = targetSubdomain
      ? [targetSubdomain.trim()]
      : await getActiveSubdomains();
    console.log(`Found ${subdomains.length} active client(s) to process`);

    for (const subdomain of subdomains) {
      console.log(`\n--- Processing tenant: ${subdomain} (Batch Size: ${batchSize}, Concurrency: ${concurrency}) ---`);

      try {
        await withTenantDb(subdomain, async (db) => {
          const colList = (await db.listCollections().toArray()).map((c) => c.name);
          const analyticsColName = colList.includes("aianalytics") ? "aianalytics" : (colList.includes("aiAnalytics") ? "aiAnalytics" : "aianalytics");
          const aiAnalytics = db.collection(analyticsColName);
          const aiResults = db.collection("aiResults");

          if (recordId) {
            const targetId = toObjectId(recordId);
            const targetQuery = targetId ? { _id: targetId } : { _id: recordId };
            const doc = await aiAnalytics.findOne(targetQuery);
            if (!doc) {
              results.push({ subdomain, id: recordId, status: "not_found", reason: "Record not found" });
              return;
            }
            const docResult = await processSingleDoc(doc, { genAI, modelName, aiAnalytics, aiResults, subdomain });
            results.push(docResult);
            return;
          }

          let currentCursor = initialCursor;
          let tenantProcessed = 0;
          let tenantSuccess = 0;
          let tenantFailed = 0;
          let tenantSkipped = 0;
          let batchesProcessed = 0;
          let lastEvaluatedId = currentCursor ? currentCursor.toString() : null;
          let hasMore = false;

          while (true) {
            if (context && typeof context.getRemainingTimeInMillis === 'function') {
              const remainingMs = context.getRemainingTimeInMillis();
              if (remainingMs < 5000) {
                console.warn(`[AI Lambda] Approaching Lambda timeout (${remainingMs}ms remaining). Halting gracefully.`);
                hasMore = true;
                break;
              }
            }

            if (maxExecutionMs && (Date.now() - startTime) >= maxExecutionMs) {
              console.log(`[AI Lambda] Reached maxExecutionMs (${maxExecutionMs}ms). Halting cleanly with resumable cursor.`);
              hasMore = true;
              break;
            }

            const fetchLimit = batchSize;

            const query = {
              status: { $in: ["client_error", "server_error"] },
              isRetried: { $ne: true },
              prompt: { $exists: true, $type: "string", $ne: "" },
              $or: [
                { retryCount: { $exists: false } },
                { retryCount: { $lt: 3 } }
              ]
            };

            if (currentCursor) {
              query._id = { $gt: currentCursor };
            }

            // O(1) Keyset seek: loads only fetchLimit documents into RAM
            const batch = await aiAnalytics
              .find(query)
              .sort({ _id: 1 })
              .limit(fetchLimit)
              .toArray();

            if (batch.length === 0) {
              hasMore = false;
              break;
            }

            batchesProcessed++;
            currentCursor = batch[batch.length - 1]._id;
            lastEvaluatedId = currentCursor.toString();

            console.log(`[AI Lambda] Batch ${batchesProcessed}: Processing ${batch.length} documents for ${subdomain} (Cursor: ${lastEvaluatedId})...`);

            const subChunks = chunkArray(batch, concurrency);
            for (const chunk of subChunks) {
              const chunkPromises = chunk.map((doc) =>
                processSingleDoc(doc, { genAI, modelName, aiAnalytics, aiResults, subdomain })
              );
              const chunkResults = await Promise.all(chunkPromises);

              for (const res of chunkResults) {
                results.push(res);
                tenantProcessed++;
                if (res.status === "success") tenantSuccess++;
                else if (res.status === "failed") tenantFailed++;
                else tenantSkipped++;
              }
            }

            console.log(`[AI Lambda] Batch ${batchesProcessed} done. Cumulative for ${subdomain}: ${tenantProcessed} (Success: ${tenantSuccess}, Failed: ${tenantFailed})`);

            if (batch.length < fetchLimit) {
              hasMore = false;
              break;
            }

            // Short pacing delay between batch chunks
            await new Promise((res) => setTimeout(res, 200));
          }

          results.push({
            subdomain,
            status: hasMore ? "in_progress" : "completed",
            hasMore,
            lastEvaluatedId,
            processed: tenantProcessed,
            successful: tenantSuccess,
            failed: tenantFailed,
            batches: batchesProcessed,
          });
        });
      } catch (error) {
        console.error(`Error processing subdomain ${subdomain}:`, error);
        results.push({ subdomain, status: "error", error: error.message });
      }
    }
  } catch (mainError) {
    console.error("Main SUPER_DB error:", mainError);
    return { statusCode: 500, body: JSON.stringify({ error: mainError.message }) };
  }

  console.log("AI Direct Retry Lambda completed successfully.");
  return { statusCode: 200, body: JSON.stringify({ results }) };
};
