#!/usr/bin/env node
// Đọc log spike đã ghi vào Neon (bảng spike_runs).
//   node tools/spike-runs.mjs list        — bảng tóm tắt mọi lần chạy
//   node tools/spike-runs.mjs latest      — chi tiết lần gần nhất
//   node tools/spike-runs.mjs show <n>    — chi tiết lần thứ n (1-based) hoặc run_id
//
// Ghi từ đâu: spike/index.html → POST /api/spike-log (prod Vercel) với x-spike-key.

import { readFileSync } from 'node:fs';
import { Client } from 'pg';

function loadEnv() {
  try {
    const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const i = line.indexOf('=');
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim().replace(/^"|"$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* không có file thì dùng env sẵn có */ }
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const short = (s, n = 46) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const num = (v) => (v === null || v === undefined ? '-' : String(v));
const hhmm = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? '--:--' : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function summarize(run) {
  const t1 = run.t1_latency_ms || {};
  const early = run.vad_early_responses || {};
  const t3 = run.t3_canary || {};
  const v1 = run.v1_vocab || {};
  return {
    mode: run.mode || '-',
    min: run.duration_sec ? Math.round(run.duration_sec / 60) + 'm' : '-',
    t1: t1.n ? `n=${t1.n} p50=${t1.p50}${t1.pass ? ' ✓' : ' ✗'}` : '-',
    early: early.count === undefined ? '-' : `${early.count}${early.pass ? ' ✓' : ' ✗'}`,
    t3: t3.pass === undefined ? '-' : t3.pass ? 'ĐẠT' : 'KHÔNG',
    v1: v1.words ? `${v1.reused}/${v1.words.length}${v1.pass ? ' ✓' : ' ✗'}` : '-',
    turns: num(run.turns)
  };
}

loadEnv();
const url = process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
if (!url) {
  console.error('Thiếu DATABASE_URL (đặt trong .env.local hoặc export trước khi chạy).');
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

const cmd = process.argv[2] || 'list';
const arg = process.argv[3];

try {
  if (cmd === 'list') {
    const { rows } = await client.query(
      'select id, run_id, payload, received_at from spike_runs order by id'
    );
    if (!rows.length) {
      console.log('Chưa có lần chạy nào trong bảng spike_runs.');
      process.exit(0);
    }
    console.log(pad('#', 4), pad('nhận lúc', 13), pad('mode', 8), pad('dài', 5), pad('T1', 20), pad('cắt sớm', 9), pad('T3', 8), pad('V1', 9), 'lượt');
    rows.forEach((r, i) => {
      const s = summarize(r.payload || {});
      console.log(pad(i + 1, 4), pad(hhmm(r.received_at), 13), pad(s.mode, 8), pad(s.min, 5), pad(s.t1, 20), pad(s.early, 9), pad(s.t3, 8), pad(s.v1, 9), s.turns);
    });
    console.log(`\n${rows.length} lần chạy. Xem chi tiết: node tools/spike-runs.mjs show <#>`);
  } else if (cmd === 'latest') {
    const { rows } = await client.query('select * from spike_runs order by id desc limit 1');
    if (!rows.length) { console.log('Chưa có lần chạy nào.'); process.exit(0); }
    console.log(JSON.stringify(rows[0].payload, null, 2));
  } else if (cmd === 'show') {
    const q = arg && arg !== 'latest' ? arg : null;
    const { rows } = q && /^\d+$/.test(q)
      ? await client.query('select * from spike_runs order by id limit 1 offset $1', [Number(q) - 1])
      : await client.query('select * from spike_runs where run_id = $1 limit 1', [q || '']);
    if (!rows.length) { console.log('Không tìm thấy lần chạy: ' + (q || 'latest')); process.exit(0); }
    const s = summarize(rows[0].payload || {});
    console.log(`run_id: ${rows[0].run_id}`);
    console.log(`nhận:   ${rows[0].received_at?.toISOString?.() || rows[0].received_at}`);
    console.log(`mode:   ${s.mode}  ·  dài ${s.min}  ·  ${s.turns} lượt`);
    console.log(`T1:     ${s.t1}`);
    console.log(`cắt sớm:${s.early}`);
    console.log(`T3:     ${s.t3}`);
    console.log(`V1:     ${s.v1}\n`);
    console.log(JSON.stringify(rows[0].payload, null, 2));
  } else {
    console.log('Dùng: list | latest | show <#>');
  }
} finally {
  await client.end();
}
