#!/usr/bin/env node
'use strict';
/**
 * BitBudCoin — koparka CPU do puli (jeden plik, zero zależności, Node 18+).
 *
 *   node bbc-miner.js BbCtwojadres...
 *   node bbc-miner.js --address BbC... --threads 2
 *   node bbc-miner.js --bench              (sam test szybkości, bez sieci)
 *
 * Co robi (żeby każdy mógł to sprawdzić czytając ten plik):
 *   1. pobiera pracę z  <url>/pool/work?minerAddress=<twój adres>
 *   2. liczy SHA-256 bloku, zmieniając tylko nonce (ten sam wzór co computeBlockHash w węźle)
 *   3. gdy hash spełnia próg udziału (share), wysyła go na <url>/pool/submit
 * Nie robi nic poza tym: nie czyta Twoich plików, nie prosi o klucz prywatny (potrzebny jest tylko adres).
 * Nagrody są naliczane w puli i wypłacane automatycznie przez payout-watcher puli — nie od razu.
 */
const { Worker, isMainThread, parentPort } = require('worker_threads');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_URL = 'https://141-147-98-57.sslip.io';
const ADDR_RE = /^t?BbC[0-9a-fA-F]{40}$/;
const BATCH = 4000;

// Ten sam wzór co computeBlockHash(): height + previousHash + timestamp + JSON(transactions) + difficulty + nonce
const hashPrefix = (j) => `${j.height}${j.previousHash}${j.timestamp}${JSON.stringify(j.transactions)}${j.difficulty}`;
const blockHash = (j, nonce) => crypto.createHash('sha256').update(hashPrefix(j) + nonce).digest('hex');

// ============================ WĄTEK ROBOCZY ============================
if (!isMainThread) {
  let job = null, running = false;
  parentPort.on('message', (m) => {
    if (m.type === 'job') { job = m; if (!running) loop(); }
    else if (m.type === 'stop') process.exit(0);
  });
  async function loop() {
    running = true;
    let cur = null, base = null, n = 0, hashes = 0, last = Date.now();
    for (;;) {
      if (job !== cur) {
        cur = job; n = cur.startNonce;
        base = crypto.createHash('sha256'); base.update(cur.prefix); // prefiks liczymy raz, potem tylko kopiujemy stan
      }
      for (let i = 0; i < BATCH; i++) {
        const h = base.copy(); h.update(String(n));
        const d = h.digest('hex');
        if (d <= cur.shareTarget) parentPort.postMessage({ type: 'share', jobId: cur.jobId, nonce: n, hash: d });
        n += cur.step;
      }
      hashes += BATCH;
      const now = Date.now();
      if (now - last >= 500) { parentPort.postMessage({ type: 'rate', hashes }); hashes = 0; last = now; }
      await new Promise((r) => setImmediate(r)); // pozwala odebrać nową pracę
    }
  }
  return;
}

// ============================ WĄTEK GŁÓWNY ============================
function parseArgs(argv) {
  const o = { url: DEFAULT_URL, threads: Math.max(1, os.cpus().length - 1), poll: 15, bench: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--address') o.address = argv[++i];
    else if (a === '--url') o.url = argv[++i];
    else if (a === '--threads') o.threads = parseInt(argv[++i], 10);
    else if (a === '--poll') o.poll = parseFloat(argv[++i]);
    else if (a === '--bench') o.bench = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('--') && !o.address) o.address = a;
    else { console.error('Nieznana opcja: ' + a); process.exit(2); }
  }
  return o;
}
const fmtRate = (h) => h >= 1e9 ? (h / 1e9).toFixed(2) + ' GH/s' : h >= 1e6 ? (h / 1e6).toFixed(2) + ' MH/s' : h >= 1e3 ? (h / 1e3).toFixed(1) + ' kH/s' : h.toFixed(0) + ' H/s';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, url, body) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { method, signal: ctl.signal, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const txt = await r.text(); let data; try { data = JSON.parse(txt); } catch (e) { data = { raw: txt.slice(0, 200) }; }
    return { status: r.status, data };
  } finally { clearTimeout(t); }
}

function validJob(j) {
  return j &&
    Number.isInteger(j.height) &&
    typeof j.previousHash === 'string' &&
    typeof j.timestamp === 'number' &&
    Array.isArray(j.transactions) &&
    typeof j.difficulty === 'number' &&
    /^[0-9a-f]{64}$/.test(j.shareTarget || '') &&
    typeof j.workId === 'string' &&
    /^[0-9a-f]{32}$/.test(j.workId);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || (!o.address && !o.bench)) {
    console.log('Użycie:  node bbc-miner.js BbCtwojadres [--threads N] [--url ADRES_PULI] [--poll SEKUNDY]\n         node bbc-miner.js --bench');
    process.exit(o.help ? 0 : 2);
  }
  if (!Number.isInteger(o.threads) || o.threads < 1 || o.threads > 64) { console.error('--threads: liczba 1–64'); process.exit(2); }
  let address = null;
  if (!o.bench) {
    if (!ADDR_RE.test(o.address || '')) { console.error('Zły adres. Oczekiwany format: BbC + 40 znaków hex (np. BbCcbcfc6f0...)'); process.exit(2); }
    // do puli idzie forma znormalizowana (małe litery), jak w portfelu — saldo jest kluczowane surowym tekstem adresu
    address = o.address.replace(/^(t?BbC)(.*)$/, (m, p, h) => p + h.toLowerCase());
  }
  const base = o.url.replace(/\/+$/, '');

  // ----- wątki -----
  const stats = { hashes: 0, ok: 0, rejected: 0, blocks: 0, credited: 0, stale: 0, started: Date.now() };
  const jobs = new Map(); let jobSeq = 0, current = null;
  const submitQueue = []; let submitting = false, hold = false, lastSubmitAt = 0;
  const workers = [];
  const nonceBase = crypto.randomInt(0, 2 ** 40);
  for (let i = 0; i < o.threads; i++) {
    const w = new Worker(__filename);
    w.on('message', (m) => {
      if (m.type === 'rate') stats.hashes += m.hashes;
      else if (m.type === 'share') {
        if (hold) return; // current job was explicitly rejected; wait for fresh server work
        const j = jobs.get(m.jobId);
        // kandydat na pełny blok idzie na początek kolejki — nigdy nie czeka za zwykłymi udziałami
        if (j && j.blockTarget && m.hash <= j.blockTarget) submitQueue.unshift(m); else submitQueue.push(m);
        if (submitQueue.length > 500) submitQueue.splice(250, 1); // zabezpieczenie, gdyby próg puli był za łatwy dla tego procesora
        pump();
      }
    });
    w.on('error', (e) => { console.error('Błąd wątku:', e.message); process.exit(1); });
    workers.push(w);
  }
  function dispatch(j) {
    const jobId = ++jobSeq;
    const rec = Object.assign({}, j, { jobId });
    jobs.set(jobId, rec); if (jobs.size > 4) jobs.delete(jobs.keys().next().value);
    current = rec;
    hold = false;
    const prefix = hashPrefix(j);
    workers.forEach((w, i) => w.postMessage({ type: 'job', jobId, prefix, shareTarget: j.shareTarget, startNonce: nonceBase + i, step: o.threads }));
  }

  if (o.bench) {
    console.log(`Test szybkości: ${o.threads} wątków, 6 sekund…`);
    dispatch({ height: 1, previousHash: '0'.repeat(64), timestamp: 1, transactions: [], difficulty: 1, shareTarget: '0'.repeat(64) });
    await sleep(6000);
    console.log('Średnio: ' + fmtRate(stats.hashes / ((Date.now() - stats.started) / 1000)) + '  (to uczciwy pomiar tego procesora, wszystkie wątki razem)');
    process.exit(0);
  }

  // ----- wysyłanie udziałów (po jednym naraz) -----
  async function pump() {
    if (submitting) return; submitting = true;
    try {
      while (submitQueue.length) {
        const m = submitQueue.shift(), j = jobs.get(m.jobId);
        if (!j) continue;
        // A share is tied to j.workId.
        // Never compare it with the target of a newer "current" job.
        const candidate = { height: j.height, previousHash: j.previousHash, timestamp: j.timestamp, transactions: j.transactions, difficulty: j.difficulty, nonce: m.nonce, hash: m.hash };
        if (blockHash(j, m.nonce) !== m.hash) { console.error('Wewnętrzny błąd hasha — pomijam'); continue; } // nigdy nie wysyłamy czegoś, co sami nie potwierdziliśmy
        const wait = 400 - (Date.now() - lastSubmitAt); // pula ma wspólny limit zapytań dla wszystkich górników
        if (wait > 0) await sleep(wait);
        lastSubmitAt = Date.now();
        let res;
        try { res = await http('POST', base + '/pool/submit', { minerAddress: address, workId: j.workId, candidate }); }
        catch (e) { stats.rejected++; await sleep(2000); continue; }
        const d = res.data || {};
        if (d.accepted) {
          stats.ok++; stats.credited += Number(d.paidNow) || 0;
          refreshSoon(); // pula po każdym udziale może podnieść trudność (VARDIFF) — bierzemy nowy cel
          if (d.blockFound) { stats.blocks++; console.log(`\n★ ZNALEZIONO BLOK na wysokości ${j.height}!`); refresh(true); }
        } else {
          stats.rejected++;
          const rejectCode = String(d.code || '');

          if (
            rejectCode === 'UNKNOWN_JOB' ||
            rejectCode === 'STALE_JOB' ||
            /nieaktualn|wysokosc/i.test(String(d.reason))
          ) {
            stats.stale++;
            hold = true;
            submitQueue.length = 0;
            current = null;
            refresh(true);
          }
          else if (
            rejectCode === 'LOW_DIFFICULTY_SHARE' ||
            /trudnosci/i.test(String(d.reason))
          ) {
            hold = true;
            submitQueue.length = 0;
            current = null;
            refresh(true);
          }
          else if (res.status === 429) await sleep(3000);
          else if (stats.rejected <= 5) console.log('Udział odrzucony: ' + (d.reason || d.error || res.status));
        }
      }
    } finally { submitting = false; }
  }

  // ----- pobieranie pracy -----
  let fails = 0, refreshing = false;
  async function refresh(force) {
    if (refreshing) return; refreshing = true;
    try {
      const r = await http('GET', `${base}/pool/work?minerAddress=${encodeURIComponent(address)}`);
      if (r.status !== 200 || !validJob(r.data)) throw new Error('odpowiedź puli: ' + JSON.stringify(r.data).slice(0, 120));
      fails = 0;
      const j = r.data, c = current;
      const changed = !c || c.height !== j.height || c.previousHash !== j.previousHash || c.shareTarget !== j.shareTarget;
      if (changed || force || Date.now() - c.fetchedAt > 45000) { dispatch(j); current.fetchedAt = Date.now(); }
    } catch (e) {
      fails++; if (fails === 1 || fails % 6 === 0) console.log('Brak połączenia z pulą (' + e.message + ') — ponawiam…');
    } finally { refreshing = false; }
  }

  let lastRefreshAt = 0, refreshTimer = null;
  function refreshSoon() { // nie częściej niż co ~1 s (limit zapytań puli jest wspólny dla wszystkich górników)
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; lastRefreshAt = Date.now(); refresh(false); }, Math.max(0, 1000 - (Date.now() - lastRefreshAt)));
  }

  console.log(`BitBudCoin koparka\n  adres:   ${address}\n  pula:    ${base}\n  wątki:   ${o.threads}\n  (Ctrl+C kończy)\n`);
  await refresh(true);
  setInterval(() => refresh(false), Math.max(1, o.poll) * 1000);
  let lastH = 0, lastT = Date.now();
  setInterval(() => {
    const now = Date.now(), rate = (stats.hashes - lastH) / ((now - lastT) / 1000); lastH = stats.hashes; lastT = now;
    const h = current ? '#' + current.height : '—';
    process.stdout.write(`\r${fmtRate(rate).padEnd(11)} | blok ${h} | udziały: ${stats.ok} przyjęte, ${stats.rejected} odrzucone | bloki: ${stats.blocks} | naliczone w puli: ${stats.credited.toFixed(4)} BbC   `);
  }, 2000);

  const bye = () => {
    const mins = ((Date.now() - stats.started) / 60000).toFixed(1);
    console.log(`\n\nKoniec po ${mins} min. Udziały przyjęte: ${stats.ok}, odrzucone: ${stats.rejected}, bloki: ${stats.blocks}, naliczone w puli: ${stats.credited.toFixed(4)} BbC (wypłata robi pula automatycznie).`);
    process.exit(0);
  };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
main().catch((e) => { console.error('Błąd:', e.message); process.exit(1); });
