declare module 'mammoth/mammoth.browser.js' {
  import type * as mammoth from 'mammoth';
  // The browser bundle exposes the same runtime shape as the node entry.
  export const extractRawText: typeof mammoth.extractRawText;
  export const convertToHtml: typeof mammoth.convertToHtml;
}
