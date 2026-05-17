#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const path = require('path');
const { connectDB, query } = require(path.join(__dirname, '../src/database/connection'));

const names = [
  'beef fat preserved with mixed tocopherols',
  'mono and dicalcium phosphate',
  'minerals zinc proteinate ferrous sulfate manganese proteinate copper proteinate calcium iodate sodium selenite',
  'l ascorbyl 2 polyphosphate vitamin c'
];

async function main() {
  await connectDB();
  for (const h of ['healthy_food', 'healthy_dry_food']) {
    console.log('\n##', h);
    for (const n of names) {
      const rows = await query(
        `SELECT ingredient_normalized, risk_score, LEFT(explanation, 120) AS ex
         FROM ai_assessment_cache
         WHERE pet_type = 'dog' AND conditions_hash = ?
           AND (ingredient_normalized = ? OR ingredient_normalized LIKE ?)
         LIMIT 5`,
        [h, n, `%${n.slice(0, 25)}%`]
      );
      console.log(n, '→', rows.length ? rows : 'NO ROW');
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
