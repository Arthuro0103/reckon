'use strict';
// `reckon --open`: ask the platform seam to open the panel in the default browser.
// The URL is built by the caller from the loopback host and the port, and the
// seam refuses anything else, so this cannot become a way to open a page.
const platform = require('./platform');

async function openPanel(url, log = console.log) {
  try {
    const r = await platform.openBrowser(url);
    if (r === false) log('  --open: the system refused to open the browser. Open the address above yourself.\n');
    else if (r === null) log('  --open: not available on this platform. Open the address above yourself.\n');
  } catch (e) {
    log('  --open: ' + String((e && e.message) || e).split('\n')[0] + '\n');
  }
}

module.exports = { openPanel };
