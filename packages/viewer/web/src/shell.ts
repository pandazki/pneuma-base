// Whether the page is shown inside the Mac app, which loads it with `?shell=mac`. The app draws the
// window around the page, keeps its server running and drags the window by the areas marked
// `data-drag`; the page leaves room for the window's buttons and drops what only a browser needs.
export const IN_SHELL = new URLSearchParams(window.location.search).get('shell') === 'mac'
