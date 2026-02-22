/**
 * validate-fixtures.js
 *
 * Validates all UnifiedEvent fixture files in src/fixtures/ against the
 * canonical JSON schema at docs/contracts/unified-event.v1.schema.json.
 *
 * Usage:  node src/validate-fixtures.js
 * Exit 0 on success, exit 1 if any fixture fails validation.
 */

'use strict';

const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const schema = require(path.join(ROOT, 'docs/contracts/unified-event.v1.schema.json'));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const validate = ajv.compile(schema);

/** All 13 canonical event types and their fixture file names. */
const FIXTURES = [
  { eventType: 'CHAT',         file: 'chat.fixture.json' },
  { eventType: 'GIFT',         file: 'gift.fixture.json' },
  { eventType: 'LIKE',         file: 'like.fixture.json' },
  { eventType: 'FOLLOW',       file: 'follow.fixture.json' },
  { eventType: 'SHARE',        file: 'share.fixture.json' },
  { eventType: 'JOIN',         file: 'join.fixture.json' },
  { eventType: 'SUBSCRIBE',    file: 'subscribe.fixture.json' },
  { eventType: 'EMOTE',        file: 'emote.fixture.json' },
  { eventType: 'BATTLE',       file: 'battle.fixture.json' },
  { eventType: 'CONNECTED',    file: 'connected.fixture.json' },
  { eventType: 'DISCONNECTED', file: 'disconnected.fixture.json' },
  { eventType: 'ERROR',        file: 'error.fixture.json' },
  { eventType: 'RAW',          file: 'raw.fixture.json' },
];

const FIXTURE_DIR = path.join(__dirname, 'fixtures');

let passed = 0;
let failed = 0;

console.log('Validating UnifiedEvent fixtures against unified-event.v1.schema.json\n');

for (const { eventType, file } of FIXTURES) {
  const fixturePath = path.join(FIXTURE_DIR, file);
  let fixture;
  try {
    fixture = require(fixturePath);
  } catch (err) {
    console.error(`  FAIL  [${eventType}]  cannot load ${file}: ${err.message}`);
    failed++;
    continue;
  }

  const valid = validate(fixture);
  if (valid) {
    console.log(`  PASS  [${eventType}]  ${file}`);
    passed++;
  } else {
    console.error(`  FAIL  [${eventType}]  ${file}`);
    for (const error of validate.errors || []) {
      console.error(`        ${error.instancePath || '/'} ${error.message}`);
    }
    failed++;
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${FIXTURES.length} fixtures.`);

if (failed > 0) {
  process.exit(1);
}
