import { Card, Pill, Section, Table, tdStyle, thStyle, type PillTone } from "./ui";
import { useT, type MessageKey } from "../i18n";

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
const BULK_STATUS: Record<string, { label: MessageKey; tone: PillTone }> = {
  created:  { label: "bulk.created",  tone: "success" },
  updated:  { label: "bulk.updated",  tone: "success" },
  applied:  { label: "bulk.applied",  tone: "success" },
  skipped:  { label: "bulk.skipped",  tone: "warning" },
  rejected: { label: "bulk.rejected", tone: "negative" },
};

export function BulkResultsCard({
  rows, detailLabel = "bulk.notes", title = "bulk.results",
}: {
  rows: readonly BulkResultRow[];
  /** Header of the third column, as a key. */
  detailLabel?: MessageKey;
  title?: MessageKey;
}) {
  const t = useT();
  const headers = [t("bulk.colStore"), t("bulk.colStatus"), t(detailLabel)];
  return (
    <Card>
      <Section title={t(title)}>
        <Table>
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              // A status we don't list shows as the server sent it.
              const known = Object.hasOwn(BULK_STATUS, r.status)
                ? BULK_STATUS[r.status] : null;
              const label = known ? t(known.label) : r.status;
              const tone: PillTone = known ? known.tone : "neutral";
              const detail = r.detail == null || r.detail === ""
                ? "—" : String(r.detail);
              return (
                <tr key={`${r.store_id}-${i}`}>
                  <td style={tdStyle}>{r.store_name || t("owner.storeHash", { id: r.store_id })}</td>
                  <td style={tdStyle}>
                    <Pill tone={tone}>{label}</Pill>
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
