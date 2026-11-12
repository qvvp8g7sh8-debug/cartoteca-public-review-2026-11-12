const { statements, terminalPurge } = require('./max-inbox-sql134.cjs');
const entries = [...Object.values(statements)];
for (let count = 1; count <= 64; count++) entries.push(terminalPurge(count));
module.exports = Object.freeze(entries);
