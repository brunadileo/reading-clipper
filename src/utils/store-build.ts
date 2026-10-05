// READ-48: true in the Chrome Web Store build (webpack --env STORE=1). The
// store build ships the page-saving purpose only: no highlighter, reader view,
// side panel or Instagram sync, and the Substack sync plus waiting-article
// finisher stay behind optional permissions. Tests and the default build see false.
declare const STORE_BUILD: boolean;

export const IS_STORE_BUILD: boolean = typeof STORE_BUILD !== 'undefined' && STORE_BUILD === true;
