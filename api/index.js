// Vercel entry point: runs the same request handler as `npm start` inside a serverless function.
//
// Vercel's file system is read-only except /tmp, and /tmp is neither shared between function
// instances nor kept between cold starts. The SQLite database therefore lives in /tmp and is a
// throwaway demo database: data can reset at any time. For persistent data, run `npm start` on a
// host with a disk, or move to a hosted database.
import { openDatabase } from '../server/database.js';
import { createApp } from '../server/index.js';
import { closeExpiredSubscriptions } from '../server/subscriptions.js';
import { runBilling } from '../server/billing.js';

const db = openDatabase(process.env.DATABASE_PATH || '/tmp/brightloop.sqlite');
const server = createApp(db);

// There is no long-running process for setInterval, so the hourly jobs run on cold start and then
// at most once an hour when requests arrive.
const HOUR = 60 * 60 * 1000;
let lastRun = 0;
function runScheduledJobs() {
  if (Date.now() - lastRun < HOUR) return;
  lastRun = Date.now();
  try { closeExpiredSubscriptions(db); } catch (error) { console.error(error); }
  try { runBilling(db); } catch (error) { console.error(error); }
}

export default function handler(req, res) {
  runScheduledJobs();
  server.emit('request', req, res);
}
