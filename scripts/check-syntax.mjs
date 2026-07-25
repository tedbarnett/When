// Syntax-check every inline <script> in public/*.html with new Function.
import { readFileSync, readdirSync } from 'node:fs';

let bad = 0;
for (const f of readdirSync('public').filter((f) => f.endsWith('.html'))) {
  const html = readFileSync('public/' + f, 'utf8');
  const re = /(<script(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)<\/script>/gi;
  let m, i = 0;
  while ((m = re.exec(html))) {
    i++;
    if (/application\/ld\+json/.test(m[1])) continue;
    try {
      new Function(m[2]);
      console.log(`OK   ${f} script#${i} (${m[2].length} chars)`);
    } catch (e) {
      bad++;
      console.error(`FAIL ${f} script#${i}: ${e.message}`);
    }
  }
}
process.exit(bad ? 1 : 0);
