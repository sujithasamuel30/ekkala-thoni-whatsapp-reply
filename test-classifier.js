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
  // Offerings — ONLY "offering" / "காணிக்கை" / "kaanikai" (Sujitha,
  // 2026-11-26). "sent" / "paid" / "amount" / "Rs" / "donation" alone
  // do NOT trigger it any more — those get the clarification LIST.
  ['I sent Rs 500 offering', 'offering'],
  ['Offering sent, Rs 1000', 'offering'],
  ['காணிக்கை அனுப்பியிருக்கிறேன்', 'offering'],
  ['காணிக்கை அனுப்பி உள்ளேன்', 'offering'],
  ['kaanikai anupi ullen', 'offering'],
  ['kaanikai', 'offering'],
  ['Paid offering through GPay', 'offering'],
  ['offering', 'offering'],
  ['I donated ₹2000 for the ministry', 'unclear'],
  ['I sent Rs 500', 'unclear'],
  ['Paid Rs 500', 'unclear'],
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
  ['Can I join the prayer meeting?', 'zoom'],
  ['சேர்ந்து ஜெபிக்கலாம்', 'prayer'],
  ['I am a member of the group', 'unclear'],
  // Zoom — wants the prayer-meeting link (option 4)
  ['Zoom link please', 'zoom'],
  ['I want to join the prayer meeting', 'zoom'],
  ['ஜெபக்கூடுகையில் கலந்துகொள்ள விரும்புகிறேன்', 'zoom'],
  ['meeting link', 'zoom'],
  // Slot — wants to book a ministry slot (option 5)
  ['I want to book a slot', 'slot'],
  ['slot book panna virumburen', 'slot'],
  ['ஸ்லாட் புக் பண்ண விரும்புகிறேன்', 'slot'],
  ['Bible reading slot', 'slot'],
  // Zoom/slot must NOT steal prayer requests
  ['Please pray for the prayer meeting', 'prayer'],
  // Clarification answers
  ['1', 'choice-1'],
  ['2', 'choice-2'],
  ['3', 'choice-3'],
  ['4', 'choice-4'],
  ['5', 'choice-5'],
  // Unclear
  ['Hello', 'unclear'],
  ['Vanakkam', 'unclear'],
  ['God bless you', 'unclear'],
  ['', 'unclear'],
  // Song question (2026-11-26) — must be unclear, NOT offering.
  // Its screenshot wrongly triggered the offering template via OCR
  // (the word "sent" in the WhatsApp system text); the text itself
  // must never classify as offering.
  ['பாட்டு அனுப்பிட்டாங்களா இல்ல போன் பண்ணி எதுவும் கேட்கணுமா அக்கா', 'unclear'],
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
    : got.kind === 'zoom' ? 'send Zoom link text (option 4)'
    : got.kind === 'slot' ? 'send slot website link text (option 5)'
    : got.kind === 'choice-1' ? 'send prayer-request.jpg (answered 1)'
    : got.kind === 'choice-2' ? 'send offering-thanks.jpg (answered 2)'
    : got.kind === 'choice-3' ? 'send joining-welcome.jpg (answered 3)'
    : got.kind === 'choice-4' ? 'send Zoom link text (answered 4)'
    : got.kind === 'choice-5' ? 'send slot website link text (answered 5)'
    : 'send clarification LIST (6 options to tap)';
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${JSON.stringify(text)}] -> ${got.kind} (expected ${expected}) — ${action} — ${got.reason}`);
}
console.log(`\n${pass} passed, ${fail} failed out of ${SAMPLES.length} samples.`);
process.exit(fail ? 1 : 0);
