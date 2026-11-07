#!/usr/bin/env node
// Tra vấn log của spike.
//   node tools/logs.mjs list            — danh sách các lần chạy
//   node tools/logs.mjs show latest     — chi tiết một lần chạy
//   node tools/logs.mjs events latest   — timeline sự kiện của một lần chạy
//   node tools/logs.mjs summary         — gộp tất cả các lần chạy
//   node tools/logs.mjs raw latest      — JSON gốc
// Tham số <id>: số thứ tự (#2), run_id, hoặc "latest".

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOG_DIR = join(ROOT, '.data', 'logs');

async function loadLines() {
  let files = [];
  try { files = (await readdir(LOG_DIR)).filter(f => f.endsWith('.jsonl')).sort(); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    const text = await readFile(join(LOG_DIR, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* dòng hỏng thì bỏ */ }
    }
  }
  // Phiên chạy trên Android/bản deploy không POST được về localhost: file JSON
  // tải tay bỏ vào .data/logs/inbox/ sẽ được đọc như một lần chạy bình thường.
  try {
    const inbox = join(LOG_DIR, 'inbox');
    for (const f of (await readdir(inbox)).filter(f => f.endsWith('.json')).sort()) {
      try {
        const run = JSON.parse(await readFile(join(inbox, f), 'utf8'));
        if (run && run.test) out.push({ kind: 'run_end', run, ts: run.finished_at || run.started_at || null, source: 'inbox:' + f });
      } catch { /* file hỏng thì bỏ */ }
    }
  } catch { /* chưa có inbox thì thôi */ }
  return out;
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const num = (v) => (v === null || v === undefined ? '-' : String(v));
const short = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const hhmm = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? '--:--' : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function pickRun(runs, arg) {
  if (!runs.length) return null;
  if (!arg || arg === 'latest') return runs[runs.length - 1];
  if (arg.startsWith('#')) return runs[Number(arg.slice(1)) - 1] || null;
  return runs.find(r => r.run.run_id === arg || String(r.idx) === arg) || null;
}

const lines = await loadLines();
const runEnds = lines.filter(l => l.kind === 'run_end' && l.run);
const runs = runEnds.map((r, i) => ({ ...r, idx: i + 1 }));
const events = lines.filter(l => l.kind === 'event');

const cmd = process.argv[2] || 'list';
const arg = process.argv[3];

if (cmd === 'list') {
  if (!runs.length) {
    console.log('Chưa có lần chạy nào trong ' + LOG_DIR);
    process.exit(0);
  }
  console.log('#   when            model                  mode   turns  p50   early  T3    V1');
  for (const r of runs) {
    const d = r.run;
    const t1 = d.t1_latency_ms || {};
    const t3 = d.t3_canary || {};
    const v1 = d.v1_vocab || {};
    console.log(
      pad('#' + r.idx, 4) +
      pad(hhmm(d.started_at), 16) +
      pad(d.model, 23) +
      pad(d.mode === 'duplex' ? 'duplex' : 'PTT', 7) +
      pad(num(d.turns), 7) +
      pad(num(t1.p50), 6) +
      pad(num(d.vad_early_responses?.count), 7) +
      pad(t3.pass === null || t3.pass === undefined ? '-' : (t3.pass ? 'OK' : 'FAIL'), 6) +
      pad(v1.words ? `${v1.reused}/${v1.words.length}` : '-', 6)
    );
  }
}

else if (cmd === 'show') {
  const r = pickRun(runs, arg);
  if (!r) { console.log('không tìm thấy lần chạy: ' + arg); process.exit(1); }
  const d = r.run;
  const t1 = d.t1_latency_ms || {};
  console.log(`#${r.idx}  ${d.started_at} → ${d.finished_at}  (${d.duration_sec}s)`);
  console.log(`model=${d.model}  mode=${d.mode}  vad=${d.vad_silence_ms}ms  explain_vi=${d.explain_vi}`);
  console.log(`turns=${d.turns}  barge_ins=${d.barge_ins}`);
  console.log(`T1   n=${num(t1.n)}  p50=${num(t1.p50)}ms  p95=${num(t1.p95)}ms  ${t1.pass ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
  console.log(`     raw=${JSON.stringify(t1.raw || [])}`);
  console.log(`VAD  cắt sớm=${num(d.vad_early_responses?.count)}  ${d.vad_early_responses?.pass ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
  const t3 = d.t3_canary || {};
  console.log(`T3   canary=${t3.probe_answered ? 'có trả lời' : 'chưa'}  pass=${t3.pass}  probe@${num(t3.probe_minute)}min`);
  console.log(`     hỏi: ${short(t3.answer, 220) || '(không có)'}`);
  const v1 = d.v1_vocab || {};
  console.log(`V1   ${num(v1.reused)}/${(v1.words || []).length} từ dùng lại, AI gieo trước ${num(v1.seeded_first)}  ${v1.pass ? 'ĐẠT' : 'KHÔNG ĐẠT'}`);
  for (const w of v1.words || []) {
    console.log(`     ${pad(w.word, 18)} ai_dùng=${w.seeded_by_ai ? 'y' : 'n'}  bạn_dùng=${w.used_by_user}`);
  }
  console.log(`transcript user (${(d.transcripts?.user || '').length} ký tự):`);
  console.log('  ' + short(d.transcripts?.user, 600));
}

else if (cmd === 'events') {
  const r = pickRun(runs, arg);
  if (!r) { console.log('không tìm thấy lần chạy: ' + arg); process.exit(1); }
  const start = new Date(r.run.started_at).getTime();
  const evs = events.filter(e => e.run_id === r.run.run_id);
  console.log(`#${r.idx}  ${evs.length} sự kiện`);
  for (const e of evs) {
    const dt = isNaN(start) ? 0 : Math.max(0, Math.round((new Date(e.ts).getTime() - start) / 1000));
    const mm = `${String(Math.floor(dt / 60)).padStart(2, '0')}:${String(dt % 60).padStart(2, '0')}`;
    console.log(`${mm}  ${pad(e.name, 22)} ${short(JSON.stringify(e.data ?? null), 160)}`);
  }
}

else if (cmd === 'summary') {
  if (!runs.length) { console.log('chưa có dữ liệu'); process.exit(0); }
  const t1runs = runs.filter(r => (r.run.t1_latency_ms?.n || 0) >= 5);
  const t3runs = runs.filter(r => r.run.t3_canary?.probe_answered);
  const v1runs = runs.filter(r => (r.run.v1_vocab?.words || []).length);
  const rate = (arr, fn) => arr.length ? `${arr.filter(fn).length}/${arr.length}` : 'chưa đo';

  const allLat = t1runs.flatMap(r => r.run.t1_latency_ms.raw || []).sort((a, b) => a - b);
  const p = (q) => allLat.length ? allLat[Math.min(allLat.length - 1, Math.round(q * (allLat.length - 1)))] : null;

  console.log(`tổng ${runs.length} lần chạy  (${runs[0].run.started_at?.slice(0, 10)} → ${runs.at(-1).run.started_at?.slice(0, 10)})`);
  console.log(`T1  đạt ${rate(t1runs, r => r.run.t1_latency_ms.pass)}  p50=${num(p(0.5))}ms  p95=${num(p(0.95))}ms  (n=${allLat.length})`);
  console.log(`VAD cắt sớm: ${rate(t1runs, r => r.run.vad_early_responses?.pass)} lần chạy sạch`);
  console.log(`T3  đạt ${rate(t3runs, r => r.run.t3_canary.pass)}`);
  console.log(`V1  đạt ${rate(v1runs, r => r.run.v1_vocab.pass)}`);
  const byMode = {};
  for (const r of runs) {
    const m = r.run.mode || '?';
    byMode[m] = byMode[m] || { n: 0, turns: 0 };
    byMode[m].n++; byMode[m].turns += r.run.turns || 0;
  }
  console.log('theo mode: ' + Object.entries(byMode).map(([m, v]) => `${m}: ${v.n} phiên, ${v.turns} lượt`).join(' | '));
}

else if (cmd === 'raw') {
  const r = pickRun(runs, arg);
  if (!r) { console.log('không tìm thấy'); process.exit(1); }
  console.log(JSON.stringify(r.run, null, 2));
}

else {
  console.log('lệnh: list | show <id> | events <id> | summary | raw <id>');
}
