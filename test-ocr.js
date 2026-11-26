#!/usr/bin/env node
/**
 * Test the OCR payment-receipt check (no Meta credentials needed).
 * Usage: node test-ocr.js
 * Feeds OCR text from photos through looksLikePaymentReceipt (server.js)
 * and prints whether it would be treated as a Google Pay receipt
 * (offering template) or a random photo (no reply).
 *
 * Regression test for the 2026-11-26 bug: a status-viewers screenshot
 * was misread as a payment receipt because the old word list had bare
 * 'sent' / 'rs' — the screenshot's WhatsApp system line says "New
 * messages will disappear ... after they're sent".
 */
'use strict';
process.env.DRY_RUN = '1'; // never send anything while testing
process.env.PORT = process.env.PORT || '3999';
const { looksLikePaymentReceipt } = require('./server');

const SAMPLES = [
  // The real 2026-11-26 case: a status-viewers screenshot. Its text has
  // "after they're sent" — must NOT be a receipt.
  ['Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them. Learn more November 1, 2026 Suji updated the message timer. New messages will disappear from this chat 7 days after they\'re sent, except when kept. November 2, 2026 Your security code with Selva Kumari changed. Tap to learn more. Monday Your security code with Suji changed. Tap to learn more. Today JOHNCY ANGELINE and 3 other contacts View all 9:04 PM 10:39 AM', false],
  // Ordinary chat text with 'sent' / 'rs' words — not receipts.
  ['message sent yesterday, first person to reply', false],
  ['I sent the song, please listen', false],
  ['God bless you', false],
  ['', false],
  // Real Google Pay receipts — must still be receipts.
  ['Google Pay Paid \u20B9500 to Ekkala Thoni UPI Transaction ID 123456789012', true],
  ['GPay \u20B91,000 sent to Sujitha', true],
  // PhonePe / Paytm / other payment screenshots — NO reply now
  // (Sujitha, 2026-11-26: only a "gpay screenshot" triggers offering).
  ['PhonePe Payment Successful Rs. 250 Paid to Rinold', false],
  ['Paytm UPI Transaction ID 987654321 Rs 100', false],
  ['BHIM UPI \u20B9200', false],
  ['Paid Rs. 500 offering', false],
];

let pass = 0, fail = 0;
for (const [text, expected] of SAMPLES) {
  const got = looksLikePaymentReceipt(text);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${JSON.stringify(text.slice(0, 80))}] -> ${got} (expected ${expected})`);
}
console.log(`\n${pass} passed, ${fail} failed out of ${SAMPLES.length} samples.`);
process.exit(fail ? 1 : 0);
