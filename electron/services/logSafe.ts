// One log sanitiser for the whole main process.
//
// Values that reach a log line often come from outside the app: API error
// text, track and playlist names, URLs, request fields. Written raw, a value
// containing a line break can forge a second, fake log entry (CWE-117), and one
// containing terminal escape codes (ESC, 0x1b) can recolour, hide or rewrite
// what a person sees when they read the log in a terminal.
//
// Until 2.6.4 this lived as seven identical one-line copies that replaced CR and
// LF with a space and nothing else. This version:
//   - escapes EVERY C0 control character, ESC and NUL included, by going through
//     JSON.stringify, so a break shows up as a visible \n instead of vanishing;
//   - blanks DEL, the C1 controls and the Unicode line/paragraph separators,
//     which JSON.stringify leaves alone;
//   - puts quotes and backslashes back the way they were, so Windows paths and
//     quoted titles still read naturally.
//
// Undoing the quote/backslash escapes cannot bring a control character back:
// after JSON.stringify the text contains none, and the undo only turns a
// two-character escape into one printable character.
//
// JSON.stringify is also a sanitiser CodeQL's js/log-injection query knows, so
// routing log values through here is visible to the scanner as well as to people.
export function logSafe(v: unknown): string {
  const escaped = JSON.stringify(String(v ?? '')).slice(1, -1)
  return escaped
    .replace(/\\(["\\])/g, '$1')
    .replace(/[\u007f-\u009f\u2028\u2029]/g, ' ')
}
