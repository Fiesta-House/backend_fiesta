#!/usr/bin/env node
/**
 * apply-natural-conversation.js
 *
 *   node scripts/apply-natural-conversation.js --dry
 *   node scripts/apply-natural-conversation.js
 *   node scripts/apply-natural-conversation.js --warmer-temp   (also raises the model temperature 0.3 -> 0.5)
 *
 * Backs up each changed file as <file>.bak-convo. Anchors that are not found are reported
 * as [MISS] and left alone.
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const WARMER = process.argv.includes('--warmer-temp');
const AGENT = path.join(process.cwd(), 'src', 'services', 'agent');
const report = [];

function patchFile(name, patches) {
  const file = path.join(AGENT, name);
  if (!fs.existsSync(file)) { report.push(['MISS', name, 'file not found']); return; }
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  let changed = false;
  for (const p of patches) {
    if (p.skipIf && text.includes(p.skipIf)) { report.push(['SKIP', name, p.name + ' (already applied)']); continue; }
    let start = -1, end = -1;
    if (typeof p.find === 'string') {
      start = text.indexOf(p.find);
      if (start !== -1) {
        if (text.indexOf(p.find, start + 1) !== -1) { report.push(['MISS', name, p.name + ' (anchor appears more than once)']); continue; }
        end = start + p.find.length;
      }
    } else {
      const m = text.match(p.find);
      if (m) { start = m.index; end = start + m[0].length; }
    }
    if (start === -1) { report.push(['MISS', name, p.name + ' (anchor not found - apply by hand)']); continue; }
    text = text.slice(0, start) + p.replace(text.slice(start, end)) + text.slice(end);
    changed = true;
    report.push(['OK', name, p.name]);
  }
  if (changed && !DRY) {
    const backup = file + '.bak-convo';
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
    fs.writeFileSync(file, crlf ? text.replace(/\n/g, '\r\n') : text);
  }
}

/* routes.ts: choosing an edition becomes a conversation, not a canned reply */
patchFile('routes.ts', [
  {
    name: 'packageSelection -> natural (the model answers; slot capture still saves the edition)',
    skipIf: "name: 'packageSelection',\n      replyMode: 'natural',",
    find: /name: 'packageSelection',(\s*replyMode: '(?:deterministic|natural)',)?/,
    replace: (o) => {
      if (/natural/.test(o)) return o;
      return "name: 'packageSelection',\n      replyMode: 'natural',";
    },
  },
]);

const A1 = 'A1. PLATFORM: you are talking to the customer on "${platform}". On "instagram" or "facebook" you CANNOT make bookings and must not start gathering name, service, date or time. When she first wants to book, answer anything she asked about the edition or session, then explain kindly that bookings are only taken on WhatsApp and point her to the WhatsApp link or button on our profile. Say this once: do not repeat it after thanks, small talk or studio questions, and repeat it only if she asks to book again. On "whatsapp" or "web" the booking flow in [B] is available.';

const D11 = 'D11. VARIETY AND ENDINGS: never open or close two replies in a row with the same wording, and treat any sample wording in these instructions as an illustration to rephrase, never a line to copy. When she thanks you or signs off, close warmly in a sentence or two and stop: no new offer, no booking prompt and no WhatsApp reminder unless she asks. Let the conversation breathe; you do not need to move her anywhere.';

const D12 = 'D12. WHEN SHE QUESTIONS YOU: if she challenges something you said ("are you sure?", "really?"), re-check it against Business Context. If it is not explicitly supported, say so plainly, correct yourself and say the team will confirm. Never repeat or embellish an answer with specifics (particular accessories, items or inclusions) that Business Context does not state.';

const promptPatches = [
  {
    name: 'A1: give the WhatsApp redirect once, and answer her question first',
    skipIf: 'Say this once: do not repeat it',
    find: /A1\. PLATFORM:[^\n]*/,
    replace: () => A1,
  },
  {
    name: 'D11 + D12: variety, warm endings, honest when challenged',
    skipIf: 'D11. VARIETY',
    find: 'D4. FORMAT AND LENGTH:',
    replace: (o) => D11 + '\n\n' + D12 + '\n\n' + o,
  },
];
if (WARMER) {
  promptPatches.push({
    name: 'model temperature 0.3 -> 0.5 (main reply only)',
    skipIf: 'messages,\n      temperature: 0.5,',
    find: 'messages,\n      temperature: 0.3,',
    replace: () => 'messages,\n      temperature: 0.5,',
  });
}
patchFile('agent.service.ts', promptPatches);

console.log('\n' + (DRY ? 'DRY RUN (nothing written)' : 'APPLIED') + '\n');
for (const [s, f, n] of report) console.log('[' + s.padEnd(4) + '] ' + f.padEnd(18) + n);
const missed = report.filter((r) => r[0] === 'MISS').length;
console.log('\n' + report.filter((r) => r[0] === 'OK').length + ' patched, ' + report.filter((r) => r[0] === 'SKIP').length + ' already applied, ' + missed + ' need a manual look.');
console.log('Next: npx tsc --noEmit, restart, and retest on Instagram and WhatsApp.\n');
process.exit(missed ? 1 : 0);