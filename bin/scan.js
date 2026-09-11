#!/usr/bin/env node
'use strict';
const scan = require('../lib/scan');
const t0 = Date.now();
scan.deep((m) => console.error(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)).then((d) => {
  console.error(`\ndeep scan finished in ${(d.ms / 1000).toFixed(0)}s`);
  console.log(JSON.stringify({ totalGB: d.panel.totalGB, out: d.panel.out.length, stay: d.panel.stay.length }, null, 2));
}).catch((e) => { console.error('failed:', e.message); process.exit(1); });
