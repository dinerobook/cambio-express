import { Navigate, useParams } from "react-router-dom";

import { useSessionStatus } from "../api/account";
import { devFileRawUrl, devFileTypeLabel, useDevFile } from "../api/developer";
import {
  Alert, ButtonLink, Card, CopyButton, ErrorState, KpiCard, KpiGrid,
  Loading, PageHeader, PageShell, Pill, Section, tokens,
} from "../components/ui";
import { PageCrumbs } from "../components/PageCrumbs";
import { homePathFor } from "../lib/access";
import { getCurrentIdentity } from "../lib/auth";
import { formatDate, formatTimestamp } from "../lib/datetime";
import { fmtNumber } from "../lib/formatters";
import { t, useT } from "../i18n";
import styles from "./DeveloperFile.module.css";

// /app/developer/files/:id — one file the register sent, as it was
// written. Same gate as the list (DeveloperFiles.tsx). The XML is
// shown as TEXT only (React escapes it); "Open as text" is the raw
// route, which the server answers as text/plain, never as XML.

const MONO = { fontFamily: tokens.fontMono };

function sizeText(bytes: number): string {
  return t("dev.sizeValue", {
    bytes: fmtNumber(bytes),
    kb: (bytes / 1024).toFixed(1),
  });
}

/** The file with a line number in front of every line (CSS draws the
 *  numbers, so copying the text never picks them up). */
function XmlLines({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  return (
    <pre className={styles.xml} data-testid="developer-xml">
      {lines.map((line, i) => (
        <span key={i} className={styles.line}>{line}{"\n"}</span>
      ))}
    </pre>
  );
}

export default function DeveloperFile() {
  useT(); // re-render on a language switch
  const { id } = useParams();
  const fileId = Number(id);
  const identity = getCurrentIdentity();
  const session = useSessionStatus();
  const impersonating = !!session.data?.impersonation;
  const query = useDevFile(Number.isFinite(fileId) ? fileId : null, impersonating);

  if (session.data && !impersonating) {
    return <Navigate to={homePathFor(identity)} replace />;
  }
  if (!session.data || query.isLoading) {
    return (
      <PageShell maxWidth="76rem">
        <PageCrumbs />
        <Loading />
      </PageShell>
    );
  }
  if (query.isError || !query.data) {
    return (
      <PageShell maxWidth="76rem">
        <PageCrumbs />
        <ErrorState
          message={t("dev.loadFileFailed")}
          onRetry={() => { void query.refetch(); }}
        />
      </PageShell>
    );
  }

  const detail = query.data;
  const file = detail.file;
  return (
    <PageShell maxWidth="76rem">
      <PageCrumbs current={file.filename} />
      <PageHeader
        title={<span style={MONO}>{file.filename}</span>}
        subtitle={t("dev.subtitle", { store: detail.store_name, id: detail.store_id })}
        actions={(
          <>
            <CopyButton text={detail.xml} label={t("dev.copyXml")} />
            <ButtonLink
              href={devFileRawUrl(file.id)} target="_blank" rel="noopener noreferrer"
            >
              {t("dev.openText")}
            </ButtonLink>
            <ButtonLink href={devFileRawUrl(file.id, true)} download={file.filename}>
              {t("dev.download")}
            </ButtonLink>
          </>
        )}
      />

      {file.imported ? (
        <Alert tone="info">{t("dev.importedNote")}</Alert>
      ) : (
        <Alert tone="error">
          <strong>{t("dev.reasonTitle")}</strong>
          <span className={styles.reason}>{file.reason}</span>
        </Alert>
      )}

      <KpiGrid>
        <KpiCard
          label={t("dev.colStatus")}
          value={file.imported
            ? <Pill tone="success">{t("dev.imported")}</Pill>
            : <Pill tone="negative">{t("dev.notImported")}</Pill>}
        />
        <KpiCard label={t("dev.fileType")} value={devFileTypeLabel(file)} />
        <KpiCard
          label={t("dev.fileDay")}
          value={file.business_date ? formatDate(file.business_date) : "—"}
        />
        <KpiCard label={t("dev.fileReceived")} value={formatTimestamp(file.received_at)} />
        <KpiCard label={t("dev.fileSize")} value={sizeText(detail.size_bytes)} />
        <KpiCard
          label={t("dev.fileLines")}
          value={fmtNumber(detail.line_count)}
          sub={t("dev.encodingValue", { encoding: detail.encoding })}
        />
      </KpiGrid>

      {detail.truncated && <Alert tone="warning">{t("dev.truncated")}</Alert>}

      <Section title={t("dev.xmlTitle")}>
        <Card>
          <XmlLines text={detail.xml} />
        </Card>
      </Section>
    </PageShell>
  );
}
