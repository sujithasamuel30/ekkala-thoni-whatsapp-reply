// Classifier for Ekkala Thoni WhatsApp auto-reply.
// Shared by server.js and test-classifier.js.
// Input: plain text (from a text message, or transcribed from a voice message).
// Output: 'prayer' | 'offering' | 'joining' | 'zoom' | 'slot' | 'unclear'
//         | 'choice-1' | 'choice-2' | 'choice-3' | 'choice-4' | 'choice-5'
//
// Categories (in priority order):
//  1. A bare "1" / "2" / "3" / "4" / "5" = answer to the clarification
//     question (1 prayer, 2 offering, 3 joining, 4 prayer meeting / Zoom,
//     5 slot booking).
//  2. ZOOM — explicit request for the prayer-meeting / Zoom link.
//     Checked FIRST (before joining/offering/prayer) because "join the
//     prayer meeting" must beat the generic "i want to join" (strong
//     joining), so the member gets the Zoom link. Bare "prayer meeting"
//     alone is NOT a zoom keyword, so "please pray for the prayer
//     meeting" stays prayer.
//  3. OFFERING — only "offering" / "காணிக்கை" / "kaanikai" (Sujitha,
//     2026-11-26). Wins over prayer: if a message has BOTH prayer and
//     offering words, offering is chosen and the fact is logged.
//  4. JOINING (strong phrases) — explicit request to join the group.
//  5. SLOT — explicit slot-booking request. Checked before prayer so
//     "I want to book a slot" gets the slot link, not a prayer reply.
//  6. PRAYER.
//  7. JOINING (weak: bare "join" / "சேர" only) — checked AFTER prayer and
//     offering, so a bare "join" stays a joining request only when nothing
//     else matched.
//  8. Neither -> 'unclear' (server asks the clarification question).
//
// Notes on joining keywords:
//  - Bare "new" and bare "member" are NOT keywords on their own:
//    "I got a new job, please pray" is a prayer, and "I am a member"
//    is a statement, not a joining request. They only count inside
//    joining phrases ("new member", "become a member").
//  - "சேர" is weak, not strong: "சேர்ந்து" means "together"
//    ("சேர்ந்து ஜெபிக்கலாம்" = let us pray together), so a bare "சேர"
//    must not beat prayer. The explicit forms "சேருங்கள்" / "சேர்க்க" /
//    "சேர்க்கவும்" are strong.

const PRAYER_WORDS = [
  'pray', 'prayer', 'praying', 'please pray', 'pray for',
  'ஜெபம்', 'ஜெப', 'ஜெபிக்க', 'ஜெபியுங்கள்', 'ஜெபிக்கவும்',
  'வேண்டுகோள்', 'வேண்டுதல்', 'வேண்டிக்கொள்',
  'heal', 'healing', 'sick', 'ill', 'hospital',
  'குணம்', 'குணமாக', 'நோய்', 'சுகம்',
  'request', 'need prayer', 'prayer request', 'ஜெப குறிப்பு', 'ஜெபக்குறிப்பு',
];

// OFFERING — only these words trigger the offering template (Sujitha,
// 2026-11-26): "offering", "kaanikai" / "காணிக்கை" (this also covers
// "காணிக்கை அனுப்பி உள்ளேன்" / "kaanikai anupi ullen"), or a Google Pay
// screenshot (checked by OCR in server.js). Everything else — "sent",
// "paid", "amount", "Rs", "donation", "tithe" — does NOT trigger it;
// those messages get the clarification LIST instead, so a wrong
// template never goes out.
const OFFERING_WORDS = [
  'offering',
  'காணிக்கை', 'காணிக்கையை',
  'kaanikai',
];

// ZOOM = wants the prayer-meeting (Zoom) link. Explicit meeting-join /
// link phrases only — bare "prayer meeting" is NOT here, so a prayer
// request mentioning the meeting is not stolen.
const ZOOM_WORDS = [
  'zoom', 'meeting link', 'join the prayer meeting', 'join prayer meeting',
  'join meeting', 'ஜெபக்கூடுகை', 'ஜெப கூடுகை',
  'கலந்துகொள்ள', 'கலந்து கொள்ள',
];

// SLOT = wants to book a ministry slot. 'slot' / 'ஸ்லாட்' is the core
// word; bare "book" is NOT a keyword ("prayer book" must not match).
const SLOT_WORDS = [
  'slot', 'ஸ்லாட்', 'புக் பண்ண', 'ministry slot',
  'ஊழியங்களை செய்ய', 'ஊழியம் செய்ய',
];

// Strong = explicit request to join the group. Beats prayer/offering.
const JOINING_STRONG = [
  'join the group', 'add me', 'add me to', 'add me in',
  'group la sera', 'group la ser',
  'சேருங்கள்', 'சேர்க்க', 'சேர்க்கவும்',
  'join panna', 'new member', 'new join',
  'please add', 'become a member', 'become member',
  'join the ministry', 'i want to join', 'group join', 'join group',
];

// Weak = bare "join" / "சேர". Checked only after prayer/offering,
// so "join the prayer meeting" stays a prayer request.
const JOINING_WEAK = ['join', 'சேர'];

function score(text, words) {
  const lower = text.toLowerCase();
  let hits = [];
  for (const w of words) {
    if (lower.includes(w.toLowerCase())) hits.push(w);
  }
  return hits;
}

function classify(rawText) {
  const text = (rawText || '').trim();
  if (!text) return { kind: 'unclear', reason: 'empty text' };

  // Bare 1 / 2 / 3 / 4 / 5 = answer to the clarification question.
  if (/^1\.?$/.test(text)) return { kind: 'choice-1', reason: 'reply "1" to clarification' };
  if (/^2\.?$/.test(text)) return { kind: 'choice-2', reason: 'reply "2" to clarification' };
  if (/^3\.?$/.test(text)) return { kind: 'choice-3', reason: 'reply "3" to clarification' };
  if (/^4\.?$/.test(text)) return { kind: 'choice-4', reason: 'reply "4" to clarification' };
  if (/^5\.?$/.test(text)) return { kind: 'choice-5', reason: 'reply "5" to clarification' };

  const strongJoining = score(text, JOINING_STRONG);
  const offeringHits = score(text, OFFERING_WORDS);
  const zoomHits = score(text, ZOOM_WORDS);
  const slotHits = score(text, SLOT_WORDS);
  const prayerHits = score(text, PRAYER_WORDS);
  const weakJoining = score(text, JOINING_WEAK);

  // Zoom first: "join the prayer meeting" beats generic "i want to join".
  if (zoomHits.length > 0) {
    return { kind: 'zoom', reason: 'prayer-meeting words: ' + zoomHits.join(', ') };
  }
  if (offeringHits.length > 0) {
    return {
      kind: 'offering',
      reason: 'offering words: ' + offeringHits.join(', ') +
        (prayerHits.length > 0 ? ' (also prayer words: ' + prayerHits.join(', ') + ' — offering wins)' : ''),
    };
  }
  if (strongJoining.length > 0) {
    return { kind: 'joining', reason: 'joining words: ' + strongJoining.join(', ') };
  }
  if (slotHits.length > 0) {
    return { kind: 'slot', reason: 'slot words: ' + slotHits.join(', ') };
  }
  if (prayerHits.length > 0) {
    return { kind: 'prayer', reason: 'prayer words: ' + prayerHits.join(', ') };
  }
  if (weakJoining.length > 0) {
    return { kind: 'joining', reason: 'joining words: ' + weakJoining.join(', ') };
  }
  return { kind: 'unclear', reason: 'no prayer, offering or joining keywords' };
}

module.exports = { classify };
