// Pictures in the check cashing app: the front and back of a check,
// the front and back of an ID, the customer's photo. A slot shows the
// saved picture (click to see it large) or offers the computer's
// camera or a file; the server cleans every picture before saving it.
// The Excella scanner will fill the check slots by itself later.
// Rules: api/Modules/CheckCashing/INVARIANTS.md ("Pictures").

import { useEffect, useRef, useState } from "react";

import { useCheckPictureBlob } from "../api/checkCashing";
import { Alert, Button, Modal, ModalActions } from "./ui";
import { useT } from "../i18n";
import { apiErrorMessage } from "../lib/api";
import { fileToBase64 } from "../lib/files";
import styles from "./CheckPictures.module.css";

const ACCEPT = "image/jpeg,image/png,image/webp";

/** An object URL for a saved picture, freed when it is no longer
 *  shown. */
function usePictureUrl(id: number | null | undefined): {
  url: string | null; failed: boolean;
} {
  const blob = useCheckPictureBlob(id);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) return undefined;
    const next = URL.createObjectURL(blob.data);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the URL lives exactly as long as this blob is shown
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob.data]);
  return { url: blob.data ? url : null, failed: blob.isError };
}

/** A saved picture; a click shows it large in a popup. */
export function PictureView({
  id, label, size = "thumb",
}: {
  id: number;
  label: string;
  size?: "thumb" | "large";
}) {
  const t = useT();
  const { url, failed } = usePictureUrl(id);
  const [open, setOpen] = useState(false);
  if (failed) return <span className={styles.missing}>{t("checkCashing.pictureFailed")}</span>;
  if (!url) return <span className={`${styles.frame} ${styles[size]} ${styles.loading}`} />;
  const img = <img src={url} alt={label} className={`${styles.img} ${styles[size]}`} />;
  if (size === "large") return img;
  return (
    <>
      <button
        type="button" className={styles.thumbButton}
        onClick={() => setOpen(true)}
        aria-label={t("checkCashing.pictureOpen", { label })}
      >
        {img}
      </button>
      <Modal
        open={open} onClose={() => setOpen(false)} title={label} size="lg"
        actions={(
          <Button type="button" tone="secondary" onClick={() => setOpen(false)}>
            {t("common.close")}
          </Button>
        )}
      >
        <img src={url} alt={label} className={styles.full} />
      </Modal>
    </>
  );
}

/** A labelled place for one picture: the saved one, and the camera
 *  and file buttons for someone who may change it (``canChange``;
 *  without it the buttons are not shown — no access, no control).
 *  ``save`` uploads the base64 picture. */
export function PictureSlot({
  label, pictureId, save, disabled, canChange = true,
}: {
  label: string;
  pictureId: number | null | undefined;
  save: (contentBase64: string) => Promise<unknown>;
  disabled?: boolean;
  canChange?: boolean;
}) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(contentBase64: string) {
    setBusy(true); setError(null);
    try {
      await save(contentBase64);
      setCamera(false);
    } catch (err) {
      setError(apiErrorMessage(err, t("checkCashing.pictureSaveFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (fileRef.current) fileRef.current.value = "";
    if (file) await send(await fileToBase64(file));
  }

  return (
    <div className={styles.slot}>
      <span className={styles.label}>{label}</span>
      {pictureId != null ? (
        <PictureView id={pictureId} label={label} />
      ) : (
        <span className={`${styles.frame} ${styles.thumb} ${styles.empty}`}>
          {t("checkCashing.noPicture")}
        </span>
      )}
      {canChange && <span className={styles.buttons}>
        <Button
          type="button" tone="ghost" size="sm" disabled={disabled || busy}
          onClick={() => { setError(null); setCamera(true); }}
        >
          {t("checkCashing.camera")}
        </Button>
        <Button
          type="button" tone="ghost" size="sm" disabled={disabled || busy}
          busy={busy && !camera}
          onClick={() => fileRef.current?.click()}
        >
          {t("checkCashing.file")}
        </Button>
      </span>}
      {canChange && (
        <input
          ref={fileRef} type="file" accept={ACCEPT} hidden
          aria-label={t("checkCashing.pictureFileFor", { label })}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      )}
      {error && !camera && <Alert tone="error">{error}</Alert>}
      <CameraDialog
        open={camera} title={label} busy={busy} error={error}
        onTake={(b64) => void send(b64)}
        onClose={() => { setCamera(false); setError(null); }}
      />
    </div>
  );
}

/** The computer's camera in a popup: a live view and "Take picture". */
function CameraDialog({
  open, title, busy, error, onTake, onClose,
}: {
  open: boolean;
  title: string;
  busy: boolean;
  error: string | null;
  onTake: (contentBase64: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let stream: MediaStream | null = null;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the view each time the popup opens
    setProblem(null);
    setLive(false);
    if (!navigator.mediaDevices?.getUserMedia) {
      setProblem(t("checkCashing.noCamera"));
      return undefined;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((tr) => tr.stop()); return; }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          void videoRef.current.play().catch(() => undefined);
        }
        setLive(true);
      })
      .catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : "";
        setProblem(name === "NotAllowedError"
          ? t("checkCashing.cameraBlocked")
          : t("checkCashing.noCamera"));
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [open, t]);

  function take() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const url = canvas.toDataURL("image/jpeg", 0.9);
    onTake(url.slice(url.indexOf(",") + 1));
  }

  return (
    <Modal
      open={open} onClose={onClose} title={title} size="lg" disabled={busy}
      actions={null}
    >
      {problem ? <Alert tone="warning">{problem}</Alert> : (
        <video ref={videoRef} className={styles.video} muted playsInline />
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <ModalActions>
        <Button type="button" tone="secondary" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button type="button" onClick={take} busy={busy} disabled={!live || busy}>
          {t("checkCashing.takePicture")}
        </Button>
      </ModalActions>
    </Modal>
  );
}
