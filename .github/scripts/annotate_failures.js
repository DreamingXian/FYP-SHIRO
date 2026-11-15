// Turns the "failing tests" section of a node:test log into one GitHub Actions
// error annotation, so the reason for a red check is visible on the pull request
// without opening the full log.
// Usage: node annotate_failures.js <log file> <title>
const fs = require('fs');

const [logFile, title = 'Failed tests'] = process.argv.slice(2);
let text = '';
try {
  text = fs.readFileSync(logFile, 'utf8');
} catch {
  console.log(`::error title=${title}::The test log ${logFile} was not written.`);
  process.exit(0);
}

// Strip colour codes
text = text.replace(/\u001b\[[0-9;]*m/g, '');

const start = text.indexOf('failing tests:');
const section = start >= 0 ? text.slice(start) : text.split('\n').slice(-60).join('\n');
const lines = section.split('\n').map(l => l.trimEnd()).filter(Boolean).slice(0, 80);

// Workflow command encoding: %, CR and LF must be escaped in the message
const message = lines.join('\n').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
console.log(`::error title=${title}::${message}`);
