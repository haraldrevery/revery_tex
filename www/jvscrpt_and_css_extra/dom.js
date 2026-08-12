// The two DOM helpers more than one module needs.
//
// Deliberately tiny. They live here rather than in whichever module happened to
// need them first, so extracting the next one does not mean importing the log
// console to get `$`.

export const $ = (id) => document.getElementById(id);

/** Hand the user a file. Used for the PDF, the compile log and the project zip. */
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  // Revoking immediately can cancel the download in some browsers; a second is
  // long enough for every one of them to have started reading it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
