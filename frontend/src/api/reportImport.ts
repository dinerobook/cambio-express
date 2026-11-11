// Report-import API. Backed by /api/v2/report-import/*.
//
// The PDF is read client-side as base64 and posted in a JSON body —
// no multipart, and (for now) nothing is stored server-side: the
// backend parses in memory and returns the rows for review.

import { api } from "../lib/api";
import { fileToBase64 } from "../lib/files";
import type { components } from "./openapi";

export type IntermexReport = components["schemas"]["IntermexReportResponse"];
export type IntermexRow = components["schemas"]["IntermexTxnRowResponse"];
export type SectionTotals = components["schemas"]["SectionTotalsResponse"];
export type IntermexCommit = components["schemas"]["IntermexCommitResponse"];


/** Upload + parse an Intermex daily-close PDF. Returns the structured
 *  rows for review. Nothing is persisted. */
export async function parseIntermexReport(file: File): Promise<IntermexReport> {
  const content_base64 = await fileToBase64(file);
  return api<IntermexReport>("/api/v2/report-import/intermex/parse", {
    method: "POST",
    json: { content_base64, filename: file.name },
  });
}

/** Commit a reviewed Intermex report into `reportDate`'s money-transfer
 *  breakdown for `storeId`. Re-uploads the same PDF — the backend
 *  re-parses server-side (never trusting client money numbers) and
 *  aggregates the active giros into the Intermex company row. Returns
 *  the reconcile comparison against transfers already logged. */
export async function commitIntermexReport(
  file: File, storeId: number, reportDate: string,
): Promise<IntermexCommit> {
  const content_base64 = await fileToBase64(file);
  return api<IntermexCommit>("/api/v2/report-import/intermex/commit", {
    method: "POST",
    json: {
      content_base64,
      filename: file.name,
      store_id: storeId,
      report_date: reportDate,
    },
  });
}
