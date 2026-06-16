const fs = require('fs');
const content = fs.readFileSync('src/routes/account.ts', 'utf8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i]) {
    const quoteCount = (lines[i].match(/'/g) || []).length;
    if (quoteCount % 2 !== 0) {
      console.log('Line', i + 1, 'has odd number of single quotes:', quoteCount);
      console.log('Content:', lines[i]);
    }
  }
}