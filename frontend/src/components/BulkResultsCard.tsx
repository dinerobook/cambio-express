import { Card, Pill, Section, Table, tdStyle, thStyle, type PillTone } from "./ui";

// The per-store outcome table every owner bulk action ends with
// (bulk add user, cross-store defaults, bulk permissions). One
// store per row: Store / Status / detail. The three pages used to
// render their own copies, and the copies had drifted — one named a
// missing store "#7", another "Store #7"; one showed the raw status
// slug in an accent pill where the others showed a label in a
// success pill.

/** One store's outcome. `store_name` may be blank (the store left
 *  the umbrella, or the endpoint only returns ids). */
export interface BulkResultRow {
  store_id: number;
  store_name?: string | null;
  status: string;
  detail?: string | number | null;
}

// Every status a bulk endpoint returns, with the tone it carries
// (UI-STANDARDS §3): a completed write is `success`, a no-op that
// needs a look is `warning`, a refusal is `negative`. An unknown
// status falls back to its own slug on a neutral pill rather than
// pretending to be one of these.
const BULK_STATUS: Record<string, { label: string; tone: PillTone }> = {
  created:  { label: "Created",  tone: "success" },
  updated:  { label: "Updated",  tone: "success" },
  applied:  { label: "Applied",  tone: "success" },
  skipped:  { label: "Skipped",  tone: "warning" },
  rejected: { label: "Rejected", tone: "negative" },
};

export function BulkResultsCard({
  rows, detailLabel = "Notes", title = "Results",
}: {
  rows: readonly BulkResultRow[];
  /** Header of the third column. */
  detailLabel?: string;
  title?: string;
}) {
  return (
    <Card>
      <Section title={title}>
        <Table>
          <thead>
            <tr>
              {["Store", "Status", detailLabel].map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const status = BULK_STATUS[r.status]
                ?? { label: r.status, tone: "neutral" as const };
              const detail = r.detail == null || r.detail === ""
                ? "—" : String(r.detail);
              return (
                <tr key={`${r.store_id}-${i}`}>
                  <td style={tdStyle}>{r.store_name || `Store #${r.store_id}`}</td>
                  <td style={tdStyle}>
                    <Pill tone={status.tone}>{status.label}</Pill>
                  </td>
                  <td style={tdStyle}>{detail}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Section>
    </Card>
  );
}
