// Classifier for Ekkala Thoni WhatsApp auto-reply.
// Shared by server.js and test-classifier.js.
// Input: plain text (from a text message, or transcribed from a voice message).
// Output: 'prayer' | 'offering' | 'joining' | 'unclear'
//         | 'choice-1' | 'choice-2' | 'choice-3'
//
// Categories (in priority order):
//  1. A bare "1" / "2" / "3" = answer to the clarification question.
//  2. JOINING (strong phrases) — explicit request to join the group.
//  3. OFFERING — money/offering words win over prayer (a concrete
//     transaction to acknowledge). If a message has BOTH prayer and
//     offering words, offering is chosen and the fact is logged.
//  4. PRAYER.
//  5. JOINING (weak: bare "join" / "சேர" only) — checked AFTER prayer and
//     offering, so "Can I join the prayer meeting?" is prayer, not joining.
//  6. Neither -> 'unclear' (server asks the clarification question).
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

const OFFERING_WORDS = [
  'offering', 'offer', 'offered', 'tithe', 'donation', 'donate', 'donated',
  'காணிக்கை', 'காணிக்கையை', 'தசமபாகம்',
  'amount', '₹', 'rs.', 'rs ', 'rupees', 'inr',
  'sent', 'paid', 'payment', 'transferred', 'transfer',
  'gpay', 'google pay', 'phonepe', 'paytm', 'upi',
  'கொடுத்தேன்', 'கொடுத்துவிட்டேன்', 'அனுப்பினேன்', 'அனுப்பியிருக்கிறேன்',
  'கொடுத்த', 'செலுத்தினேன்',
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

  // Bare 1 / 2 / 3 = answer to the clarification question.
  if (/^1\.?$/.test(text)) return { kind: 'choice-1', reason: 'reply "1" to clarification' };
  if (/^2\.?$/.test(text)) return { kind: 'choice-2', reason: 'reply "2" to clarification' };
  if (/^3\.?$/.test(text)) return { kind: 'choice-3', reason: 'reply "3" to clarification' };

  const strongJoining = score(text, JOINING_STRONG);
  const offeringHits = score(text, OFFERING_WORDS);
  const prayerHits = score(text, PRAYER_WORDS);
  const weakJoining = score(text, JOINING_WEAK);

  if (strongJoining.length > 0) {
    return { kind: 'joining', reason: 'joining words: ' + strongJoining.join(', ') };
  }
  if (offeringHits.length > 0) {
    return {
      kind: 'offering',
      reason: 'offering words: ' + offeringHits.join(', ') +
        (prayerHits.length > 0 ? ' (also prayer words: ' + prayerHits.join(', ') + ' — offering wins)' : ''),
    };
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
