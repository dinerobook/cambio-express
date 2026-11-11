// Reading a file the person picked, for an API that takes base64
// (report imports, POS imports, check cashing pictures). One copy:
// UI-STANDARDS §6.

/** A File as base64, without the `data:...;base64,` prefix. */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}
