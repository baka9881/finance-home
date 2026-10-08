import { authenticatedWorkerRequest, validRequestId, runSyncWorker } from "../lib/sync-runtime.mts";

export default async (request: Request) => {
  const automationToken = Netlify.env.get("FINANCE_AUTOMATION_TOKEN")?.trim();
  if (!authenticatedWorkerRequest(request, automationToken)) {
    // Background responses are discarded by Netlify. Return without making
    // any backend request for unauthenticated public invocations.
    console.warn("finance_sync_worker_unauthorized");
    return new Response(null, { status: 401 });
  }

  const body = await request.text().catch(() => "");
  let requestId: unknown;
  try {
    if (body.length <= 1_024) requestId = JSON.parse(body)?.request_id;
  } catch { /* An invalid body must not start a backend update. */ }
  if (!validRequestId(requestId)) {
    console.warn("finance_sync_worker_invalid_request_id");
    return new Response(null, { status: 400 });
  }

  await runSyncWorker(Netlify.env.get("FINANCE_AUTOMATION_URL"), automationToken!, requestId);
};

export const config = { background: true };
