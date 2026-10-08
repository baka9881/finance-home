import { dispatchSyncWorker, scheduledRequestId, type SiteContext } from "../lib/sync-runtime.mts";

// The scheduled function has a 30-second limit. Only dispatch here; the
// authenticated background worker handles backend cold starts and backoff.
export default async (request: Request, context: SiteContext) => {
  const payload: unknown = await request.json().catch(() => null);
  await dispatchSyncWorker(context, Netlify.env.get("FINANCE_AUTOMATION_TOKEN"), scheduledRequestId(payload));
};

export const config = {
  schedule: "7 * * * *",
};
