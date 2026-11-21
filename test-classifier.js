#!/usr/bin/env node
/**
 * Test the classifier (no Meta credentials needed).
 * Usage: node test-classifier.js
 * Feeds sample text + voice-transcript messages through classify.js and
 * prints which template would be sent (or whether the clarification
 * question would be asked).
 */
'use strict';
const { classify } = require('./classify');

const SAMPLES = [
  // Prayer requests
  ['Please pray for my mother, she is in hospital', 'prayer'],
  ['Prayer request for my family', 'prayer'],
  ['என் குடும்பத்துக்காக ஜெபியுங்கள்', 'prayer'],
  ['ஜெப குறிப்பு: என் மகனுக்கு வேலை கிடைக்க ஜெபியுங்கள்', 'prayer'],
  ['Please pray, my father is sick', 'prayer'],
  ['pray for us', 'prayer'],
  // Offerings
  ['I sent Rs 500 offering', 'offering'],
  ['Offering sent, Rs 1000', 'offering'],
  ['காணிக்கை அனுப்பியிருக்கிறேன்', 'offering'],
  ['I donated ₹2000 for the ministry', 'offering'],
  ['Paid offering through GPay', 'offering'],
  ['offering', 'offering'],
  // Both prayer + offering (offering wins — money to acknowledge)
  ['I sent Rs 500 offering, please pray for my family', 'offering'],
  // Joining — new member wants to join
  ['I want to join the group', 'joining'],
  ['Add me to the group please', 'joining'],
  ['I am new, please add me', 'joining'],
  ['group la sera please', 'joining'],
  ['join panna', 'joining'],
  ['என்னை group la சேருங்கள்', 'joining'],
  ['I am a new member', 'joining'],
  ['Please add me in the Ekkala Thoni group', 'joining'],
  // Joining must NOT steal prayer/offering messages
  ['I got a new job, please pray for me', 'prayer'],
  ['Can I join the prayer meeting?', 'prayer'],
  ['சேர்ந்து ஜெபிக்கலாம்', 'prayer'],
  ['I am a member of the group', 'unclear'],
  // Clarification answers
  ['1', 'choice-1'],
  ['2', 'choice-2'],
  ['3', 'choice-3'],
  // Unclear
  ['Hello', 'unclear'],
  ['Vanakkam', 'unclear'],
  ['God bless you', 'unclear'],
  ['', 'unclear'],
];

const TEMPLATE = {
  prayer: 'prayer-request.jpg',
  offering: 'offering-thanks.jpg',
  joining: 'joining-welcome.jpg',
};

let pass = 0, fail = 0;
for (const [text, expected] of SAMPLES) {
  const got = classify(text);
  const ok = got.kind === expected;
  if (ok) pass++; else fail++;
  const action = got.kind === 'prayer' || got.kind === 'offering' || got.kind === 'joining'
    ? `send ${TEMPLATE[got.kind]}`
    : got.kind === 'choice-1' ? 'send prayer-request.jpg (answered 1)'
    : got.kind === 'choice-2' ? 'send offering-thanks.jpg (answered 2)'
    : got.kind === 'choice-3' ? 'send joining-welcome.jpg (answered 3)'
    : 'ask clarification (Prayer / Offering / Joining? 1 / 2 / 3)';
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${JSON.stringify(text)}] -> ${got.kind} (expected ${expected}) — ${action} — ${got.reason}`);
}
console.log(`\n${pass} passed, ${fail} failed out of ${SAMPLES.length} samples.`);
process.exit(fail ? 1 : 0);
