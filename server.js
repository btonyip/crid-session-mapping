'use strict';
/*
 * MOCK DEMO. This is not Trulioo.
 *
 * One Express server hosting three clearly separated logical parts:
 *
 *   PART 1  Fake Trulioo   (/trulioo/*, plus /launch/* for the end-user page)
 *   PART 2  SEEK's backend (/seek/*)
 *   PART 3  Static frontend (public/index.html)
 *
 * SEEK's backend talks to the fake Trulioo over real HTTP (fetch to localhost),
 * and the fake Trulioo delivers webhooks to SEEK over real HTTP, so the request
 * and response shown in the UI are exactly what went over the wire.
 *
 * Everything is in memory. No real credentials, no real personal data, no
 * external network calls.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`; // internal address: server calls itself here
// Address shown to users and used in signed URLs. Render and Railway set one of these automatically.
const PUBLIC = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : BASE)).replace(/\/$/, '');
// Optional shared password for the whole demo (HTTP basic auth, any username).
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || '';
// Lets the server's own calls to itself skip the password gate. Random per boot, never shown.
const INTERNAL_KEY = crypto.randomBytes(16).toString('hex');
const FLOW_ID = 'demo-flow-001';

const hex = (n = 4) => crypto.randomBytes(n).toString('hex');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

/* ========================================================================== *
 * WORKSPACES: one isolated copy of all state per visitor
 *
 * Each browser gets a cookie ("ws") that selects its own fake Trulioo (T) and
 * SEEK (S) state, so several people can use the hosted demo at once without
 * resetting each other. The server's calls to itself carry an x-demo-ws header,
 * and end-user links resolve their workspace from the signed-url token, so
 * opening a link on another device still lands in the right workspace.
 * `T` and `S` below are proxies onto the current request's workspace.
 * ========================================================================== */
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();
const workspaces = new Map();   // id -> { id, T, S, epoch, last }
const stIndex = new Map();      // signed-url token -> workspace id
const MAX_WORKSPACES = 300, IDLE_MS = 2 * 60 * 60 * 1000;

function getWorkspace(id) {
  let ws = id && workspaces.get(id);
  if (!ws) {
    if (workspaces.size >= MAX_WORKSPACES) workspaces.delete(workspaces.keys().next().value);
    ws = { id: hex(12), T: null, S: null, epoch: 0, last: 0 };
    workspaces.set(ws.id, ws);
    als.run(ws, () => { ws.T = freshTrulioo(); ws.S = freshSeek(); });
  }
  ws.last = Date.now();
  return ws;
}
const cur = () => als.getStore();
const stateProxy = (key) => new Proxy({}, {
  get: (_, k) => cur()[key][k],
  set: (_, k, v) => { cur()[key][k] = v; return true; },
});
const T = stateProxy('T');
const S = stateProxy('S');
const getEpoch = () => cur().epoch;
setInterval(() => {
  for (const [id, ws] of workspaces) if (Date.now() - ws.last > IDLE_MS) workspaces.delete(id);
  for (const [st, id] of stIndex) if (!workspaces.has(id)) stIndex.delete(st);
}, 10 * 60 * 1000).unref();

function readCookie(req, name) {
  const m = new RegExp('(?:^|; )' + name + '=([^;]*)').exec(req.headers.cookie || '');
  return m && m[1];
}

// Password gate. Server-to-self calls (x-demo-internal) and end-user /launch links
// (protected by an unguessable token) are exempt.
app.use((req, res, next) => {
  if (!DEMO_PASSWORD) return next();
  if (req.get('x-demo-internal') === INTERNAL_KEY || req.path.startsWith('/launch/')) return next();
  const m = /^Basic (.+)$/i.exec(req.get('authorization') || '');
  const given = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(given), b = Buffer.from(DEMO_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="CRID demo (MOCK)"').status(401).send('Password required.');
});

// Pick the workspace for this request, then run the rest of the request inside it.
app.use((req, res, next) => {
  const fromSt = req.query.st && stIndex.get(req.query.st);
  const id = req.get('x-demo-ws') || fromSt || readCookie(req, 'ws');
  const ws = getWorkspace(id);
  if (readCookie(req, 'ws') !== ws.id) {
    res.append('Set-Cookie', `ws=${ws.id}; Path=/; HttpOnly; SameSite=Lax${PUBLIC.startsWith('https') ? '; Secure' : ''}`);
  }
  als.run(ws, next);
});

/* ========================================================================== *
 * PART 1: FAKE TRULIOO
 *
 * Mirrors real paths and shapes where noted. SIMPLIFIED parts are flagged.
 * ========================================================================== */

function freshTrulioo() {
  return {
    tokenSeq: 0,
    tokens: new Set(),
    sessions: new Map(),   // x-hf-session id -> session
    signed: new Map(),     // signed-url "st" token -> session id
    lastEvent: null,
    webhookUrl: `${BASE}/seek/webhook`,
  };
}

function truliooError(res, status, code, message) {
  return res.status(status).json({ code, message });
}

// REAL behaviour: a session ("end client") is created the first time a flow is
// requested without an x-hf-session header, or when signed-url is called
// without endClientId.
function createSession(flowId) {
  const s = {
    id: 'hf_' + hex(8),
    flowId,
    stage: 'crid',            // crid -> doc -> done
    stepId: 'step_' + hex(6), // the body "id" of a step. NOT the session id.
    elementId: 'el_' + hex(4),
    docStepId: 'step_' + hex(6),
    shortCode: hex(3).toUpperCase(),
    crid: null,
    opened: false,
    done: false,
    createdAt: Date.now(),
  };
  T.sessions.set(s.id, s);
  return s;
}

function currentStep(s) {
  if (s.stage === 'crid') {
    // REAL shape (trimmed): a form step with one hidden, prefillable element.
    return {
      id: s.stepId,
      type: 'form',
      title: 'CustomerReferenceID',
      elements: [{
        id: s.elementId,
        name: 'External Customer ID',
        role: 'external_customer_id',
        prefillOptions: 'prefillable_non_editable_hidden',
        value: '',
      }],
    };
  }
  if (s.stage === 'doc') return { id: s.docStepId, type: 'trulioo_doc_v', shortCode: s.shortCode };
  return { id: s.docStepId, type: 'completed' };
}

// Webhook dispatcher. One POST per event. Slight delay so the UI shows the
// events arriving rather than everything happening in one tick.
function dispatchEvent(type, userId) {
  const evt = { id: 'evt_' + hex(5), event: { type, userId } };
  T.lastEvent = evt;
  const myEpoch = getEpoch();
  setTimeout(() => {
    if (myEpoch !== getEpoch()) return;
    postEvent(evt);
  }, 350);
}
function postEvent(evt) {
  fetch(T.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-demo-internal': INTERNAL_KEY, 'x-demo-ws': cur().id },
    body: JSON.stringify(evt),
  }).catch(() => {});
}

const tr = express.Router();

function requireBearer(req, res, next) {
  const m = /^Bearer (.+)$/i.exec(req.get('authorization') || '');
  if (!m || !T.tokens.has(m[1])) return truliooError(res, 401, 401, 'Unauthorized');
  next();
}

// POST /connect/token  (REAL path; accepts any non-empty client_id/secret)
tr.post('/connect/token', (req, res) => {
  const { client_id, client_secret } = req.body || {};
  if (!client_id || !client_secret) return res.status(401).json({ error: 'invalid_client' });
  const token = `mock-token-${++T.tokenSeq}`;
  T.tokens.add(token);
  res.json({ Token: token, TokenType: 'bearer', ExpiresIn: 3599 });
});

// GET /wfs/interpreter-v2/flow/:flowId
// REAL behaviour: no x-hf-session header => NEW SESSION is created and returned
// in the x-hf-session RESPONSE HEADER. With the header => current step.
//
// DEMO SHIM: a header-less call normally does NOT fire FLOW_START in this mock
// (otherwise SEEK's own correct call would). The BROKEN webhook handler adds
// `x-demo-fire-start: 1` to emulate "a new session fires FLOW_START", which is
// what makes the feedback loop visible. This header does not exist in reality.
tr.get('/wfs/interpreter-v2/flow/:flowId', requireBearer, (req, res) => {
  const sid = req.get('x-hf-session');
  let s;
  if (!sid) {
    s = createSession(req.params.flowId);
    res.set('x-hf-session', s.id);
    if (req.get('x-demo-fire-start') === '1') {
      s.opened = true;
      dispatchEvent('FLOW_START', s.id);
    }
  } else {
    s = T.sessions.get(sid);
    if (!s) return truliooError(res, 404, 4100, `End client with ID '${sid}' was not found.`);
  }
  res.json(currentStep(s));
});

// POST /wfs/interpreter-v2/submit/:flowId
// SIMPLIFIED: the real submit body is richer. Here: {"fieldData": {"<elementId>": "<value>"}}.
tr.post('/wfs/interpreter-v2/submit/:flowId', requireBearer, (req, res) => {
  const sid = req.get('x-hf-session');
  if (!sid) return truliooError(res, 400, 4000, 'x-hf-session header is required.');
  const s = T.sessions.get(sid);
  if (!s) return truliooError(res, 404, 4100, `End client with ID '${sid}' was not found.`);
  if (s.stage !== 'crid') return truliooError(res, 409, 4101, 'Session is not on a submittable step.');
  const value = req.body && req.body.fieldData && req.body.fieldData[s.elementId];
  if (!value) return truliooError(res, 400, 4000, `fieldData['${s.elementId}'] is required.`);
  s.crid = String(value);
  s.stage = 'doc';
  res.json({ type: 'trulioo_doc_v', shortCode: s.shortCode });
});

// POST /wfs/interpreter-v2/signed-url/:flowId?endClientId=<id>
// REAL behaviour (key teaching point): endClientId missing => a NEW session is created.
tr.post('/wfs/interpreter-v2/signed-url/:flowId', requireBearer, (req, res) => {
  const id = req.query.endClientId;
  let s;
  if (id) {
    s = T.sessions.get(id);
    if (!s) return truliooError(res, 404, 4100, `End client with ID '${id}' was not found.`);
  } else {
    s = createSession(req.params.flowId);
  }
  const st = 'st_' + hex(10);
  T.signed.set(st, s.id);
  stIndex.set(st, cur().id);
  res.json({ endClientId: s.id, signedUrl: `${PUBLIC}/launch/${req.params.flowId}?st=${st}` });
});

// GET /wfs/export/v2/query/client/:id
// SIMPLIFIED: real profiles carry far more. Kept: id, status, flowData.<node>.fieldData.<fieldId>.value
tr.get('/wfs/export/v2/query/client/:id', requireBearer, (req, res) => {
  const s = T.sessions.get(req.params.id);
  if (!s) return truliooError(res, 404, 4100, `End client with ID '${req.params.id}' was not found.`);
  const flowData = {};
  if (s.crid) {
    flowData.CustomerReferenceID = {
      fieldData: { [s.elementId]: { role: 'external_customer_id', value: s.crid } },
    };
  }
  res.json({ id: s.id, status: s.done ? 'COMPLETED' : 'IN_PROGRESS', flowData });
});

// Demo helper: re-deliver the last webhook with the SAME event id (dedupe demo).
tr.post('/_demo/replay-last', (req, res) => {
  if (!T.lastEvent) return res.status(404).json({ error: 'no event yet' });
  postEvent(T.lastEvent);
  res.json({ replayed: T.lastEvent.id });
});

app.use('/trulioo', tr);

// ---- End-user pages (what the signed URL opens) ---------------------------

function fakeQr(seed) {
  // Placeholder only: a deterministic pseudo-random grid, not a scannable QR code.
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => ((h = (h * 1664525 + 1013904223) >>> 0) / 4294967296);
  const N = 21, C = 8;
  const finder = (x, y) => (x < 7 && y < 7) || (x >= N - 7 && y < 7) || (x < 7 && y >= N - 7);
  let rects = '';
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let on;
      if (finder(x, y)) {
        const fx = x >= N - 7 ? x - (N - 7) : x, fy = y >= N - 7 ? y - (N - 7) : y;
        on = fx === 0 || fx === 6 || fy === 0 || fy === 6 || (fx >= 2 && fx <= 4 && fy >= 2 && fy <= 4);
      } else on = rnd() > 0.5;
      if (on) rects += `<rect x="${x * C}" y="${y * C}" width="${C}" height="${C}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${N * C} ${N * C}" width="168" height="168" aria-label="Fake QR placeholder">${rects}</svg>`;
}

function launchPage(s, st, flowId) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock verification</title>
<style>
body{font:15px system-ui,sans-serif;margin:0;background:#f5f6f8;color:#1a1a1a;text-align:center}
.b{background:#b91c1c;color:#fff;font-weight:600;padding:6px;font-size:12px}
main{padding:18px}
.qr{background:#fff;display:inline-block;padding:10px;border:1px solid #ddd;border-radius:8px;margin:10px 0}
button{background:#ea580c;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:15px;cursor:pointer}
button:disabled{background:#999;cursor:default}
small{display:block;color:#777;margin-top:14px;font-family:ui-monospace,monospace;font-size:11px;word-break:break-all}
</style></head><body>
<div class="b">MOCK DEMO. This is not Trulioo.</div>
<main>
<h3>Verify your identity</h3>
<p>Scan this code with your phone to continue.<br><em>(placeholder, not a real QR code)</em></p>
<div class="qr">${fakeQr(s.id)}</div><br>
<button id="complete">Complete verification</button>
<p id="msg"></p>
<small>demo info: session ${s.id}</small>
</main>
<script>
document.getElementById('complete').addEventListener('click', async function(){
  this.disabled = true;
  await fetch('/launch/${flowId}/complete?st=${st}', {method:'POST'});
  document.getElementById('msg').textContent = 'Verification complete (mock). You can close this page.';
});
</script></body></html>`;
}

// Loading the page = the end user opening the link => FLOW_START (once per session).
app.get('/launch/:flowId', (req, res) => {
  const sid = T.signed.get(req.query.st);
  const s = sid && T.sessions.get(sid);
  if (!s) return res.status(403).send('Invalid or expired link (mock).');
  if (!s.opened) {
    s.opened = true;
    dispatchEvent('FLOW_START', s.id);
  }
  res.send(launchPage(s, req.query.st, req.params.flowId));
});

// The "Complete verification" button => FLOW_END (once per session).
app.post('/launch/:flowId/complete', (req, res) => {
  const sid = T.signed.get(req.query.st);
  const s = sid && T.sessions.get(sid);
  if (!s) return res.status(403).json({ error: 'invalid link' });
  if (!s.done) {
    s.done = true;
    s.stage = 'done';
    dispatchEvent('FLOW_END', s.id);
  }
  res.json({ ok: true });
});

/* ========================================================================== *
 * PART 2: SEEK'S BACKEND  (/seek)
 *
 * Pretend this is SEEK's own service. It only knows Trulioo through HTTP.
 * ========================================================================== */

function freshSeek() {
  return {
    token: null,
    tokenEntry: null,           // the call that fetched the cached token, for display
    mapping: new Map(),         // x-hf-session -> {crid, customerName, status}   (SEEK's DB table)
    customers: new Map(),       // crid -> run state used by the stepper UI
    orphans: new Map(),         // userIds from webhooks we could not map
    seen: new Set(),            // processed webhook event ids (dedupe)
    broken: false,
    loop: { created: 0, cap: 25, tripped: false },
    trace: [],                  // outbound/inbound calls shown by the stepper
    traceSeq: 0,
    events: [],                 // webhook log
  };
}

function addTrace(e) {
  e.n = ++S.traceSeq;
  e.ts = Date.now();
  S.trace.push(e);
  if (S.trace.length > 300) S.trace.shift();
  return e;
}

// Outbound HTTP to (fake) Trulioo with full request/response capture.
async function callTrulioo(method, p, { headers = {}, body, form } = {}) {
  const url = PUBLIC + p; // what the UI shows
  const internal = { 'x-demo-internal': INTERNAL_KEY, 'x-demo-ws': cur().id };
  const h = { ...headers };
  let payload;
  let shownBody;
  if (form) {
    payload = new URLSearchParams(form).toString();
    h['content-type'] = 'application/x-www-form-urlencoded';
    shownBody = payload;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
    shownBody = body;
  }
  const r = await fetch(BASE + p, { method, headers: { ...h, ...internal }, body: payload });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  const rh = {};
  r.headers.forEach((v, k) => { if (k === 'x-hf-session' || k === 'content-type') rh[k] = v; });
  return {
    status: r.status,
    headers: rh,
    body: parsed,
    request: { method, url, headers: h, body: shownBody },
    response: { status: r.status, headers: rh, body: parsed },
  };
}

// Token handling: fetched once, then cached (real tokens last ~1h, ExpiresIn 3599).
// Expiry handling is omitted in this demo.
async function getToken(ctx) {
  if (S.token) {
    if (ctx) {
      addTrace({
        ...ctx, actor: 'seek', title: 'Token already cached, no call made',
        request: null, response: null,
        local: 'SEEK reuses the token it already holds.\nA real client refreshes before ExpiresIn (3599s) runs out.\n\nOriginal call:\n' +
          `${S.tokenEntry.request.method} ${S.tokenEntry.request.url}  ->  HTTP ${S.tokenEntry.response.status}`,
      });
    }
    return S.token;
  }
  const r = await callTrulioo('POST', '/trulioo/connect/token', {
    form: {
      grant_type: 'client_credentials',
      scope: 'workflow.studio.api',
      client_id: 'seek-demo-client',
      client_secret: 'mock-secret',
    },
  });
  S.token = r.body.Token;
  if (ctx) S.tokenEntry = addTrace({ ...ctx, actor: 'seek', title: 'Request an access token', request: r.request, response: r.response });
  else S.tokenEntry = { request: r.request, response: r.response };
  return S.token;
}

// Bearer header for a call. The `noAuth` fault drops it on purpose.
const auth = (t, c) => (c && c.faults.has('noAuth') ? {} : { authorization: `Bearer ${t}` });

// FAULTS: things the demo user can deliberately omit/get wrong. Each fault is
// applied at one step; the UI warns what error to expect before the step runs.
//   noAuth           step 1  Authorization header omitted        -> 401, flow stops
//   stepIdAsSession  step 2  body "id" used as the session       -> 404 code 4100 on steps 4-6
//   skipMapping      step 3  CRID <-> session never stored       -> webhook lookup fails
//   noSessionHeader  step 4  x-hf-session omitted on submit      -> 400
//   noCrid           step 4  empty CRID value submitted          -> 400
//   noEndClientId    step 6  endClientId omitted on signed-url   -> NEW session, mismatch

// The correct flow, one step at a time (the stepper UI calls these individually;
// /seek/api/start-verification runs 0..6 back to back).
async function runStep(c, n) {
  const ctx = { step: n, crid: c.crid };
  const failed = (r) => r.status >= 400;
  switch (n) {
    case 0:
      await getToken(ctx);
      break;
    case 1: {
      const tok = await getToken();
      const r = await callTrulioo('GET', `/trulioo/wfs/interpreter-v2/flow/${FLOW_ID}`, { headers: auth(tok, c) });
      c.flowResp = r;
      if (failed(r)) c.blocked = 'GET flow was rejected, so no session exists. The flow cannot continue.';
      addTrace({
        ...ctx, actor: 'trulioo', title: 'GET flow with NO x-hf-session: Trulioo creates a session',
        request: r.request, response: r.response,
        note: failed(r) ? 'No session was created. There is nothing for SEEK to bind a CRID to.' : null,
      });
      break;
    }
    case 2: {
      const wrong = c.faults.has('stepIdAsSession');
      c.session = wrong ? c.flowResp.body.id : c.flowResp.headers['x-hf-session'];
      c.elementId = (c.flowResp.body.elements || []).find((e) => e.role === 'external_customer_id').id;
      addTrace({
        ...ctx, actor: 'seek', title: wrong ? 'Read the session from the response BODY (wrong)' : 'Read the session from the response header',
        request: null, response: null,
        local: (wrong
          ? `session = response.body.id\n        = ${c.session}      <- WRONG: this is a STEP id\n\n` +
            `(the real session, ${c.flowResp.headers['x-hf-session']}, was in the x-hf-session header)`
          : `session = response.headers['x-hf-session']\n        = ${c.session}      <- THIS is the session\n\n` +
            `response.body.id = ${c.flowResp.body.id}      <- a STEP id, not the session`),
        note: wrong ? 'Every later call that uses this value will fail with 404 code 4100.' : null,
      });
      break;
    }
    case 3: {
      c.status = 'SESSION_BOUND';
      if (c.faults.has('skipMapping')) {
        addTrace({
          ...ctx, actor: 'seek', title: 'CRID <-> x-hf-session NOT stored (skipped)',
          request: null, response: null,
          local: '-- no INSERT executed --',
          note: 'Trulioo will later send webhooks with userId = this session, and SEEK will have no row to look up.',
        });
      } else {
        S.mapping.set(c.session, { crid: c.crid, customerName: c.customerName, status: 'SESSION_BOUND' });
        addTrace({
          ...ctx, actor: 'seek', title: 'Store CRID <-> x-hf-session in SEEK\'s database',
          request: null, response: null,
          local: `INSERT INTO verification_sessions\n  (crid, hf_session, status)\nVALUES\n  ('${c.crid}', '${c.session}', 'SESSION_BOUND');\n\n` +
            'Webhooks only carry the session id, so this row is how SEEK finds the customer later.',
        });
      }
      break;
    }
    case 4: {
      const tok = await getToken();
      const headers = auth(tok, c);
      if (!c.faults.has('noSessionHeader')) headers['x-hf-session'] = c.session;
      const value = c.faults.has('noCrid') ? '' : c.crid;
      const r = await callTrulioo('POST', `/trulioo/wfs/interpreter-v2/submit/${FLOW_ID}`, {
        headers, body: { fieldData: { [c.elementId]: value } },
      });
      const m = S.mapping.get(c.session);
      if (!failed(r)) { c.status = 'CRID_SUBMITTED'; if (m) m.status = c.status; }
      addTrace({
        ...ctx, actor: 'trulioo', title: 'Submit the CRID into the hidden form field', request: r.request, response: r.response,
        note: failed(r) ? 'The CRID was NOT stored on Trulioo\'s side. Step 5 will show an empty flowData.' : null,
      });
      break;
    }
    case 5: {
      const tok = await getToken();
      const r = await callTrulioo('GET', `/trulioo/wfs/export/v2/query/client/${c.session}`, { headers: auth(tok, c) });
      addTrace({
        ...ctx, actor: 'trulioo', title: 'Optional check: export query shows the CRID on Trulioo\'s side', request: r.request, response: r.response,
        note: failed(r) ? 'Trulioo does not know this session id.'
          : (r.body.flowData && Object.keys(r.body.flowData).length ? null : 'flowData is empty: Trulioo has no CRID for this session.'),
      });
      break;
    }
    case 6: {
      const tok = await getToken();
      const omit = c.faults.has('noEndClientId');
      c.omit = omit;
      const q = omit ? '' : `?endClientId=${c.session}`;
      const r = await callTrulioo('POST', `/trulioo/wfs/interpreter-v2/signed-url/${FLOW_ID}${q}`, { headers: auth(tok, c) });
      let note;
      if (failed(r)) {
        c.blocked = 'No signed URL could be generated, so there is no link to send to the end user.';
        note = 'No link was produced. The end user has nothing to open.';
      } else {
        c.signedUrl = r.body.signedUrl;
        c.signedSession = r.body.endClientId;
        c.status = 'LINK_SENT';
        const m = S.mapping.get(c.session);
        if (m) m.status = c.status;
        note = c.signedSession !== c.session
          ? `MISMATCH: Trulioo created a NEW session (${c.signedSession}). SEEK's table still says ${c.crid} <-> ${c.session}, a session nobody will ever open.`
          : `endClientId in the response (${c.signedSession}) matches the session SEEK stored. SEEK now sends the link to the end user.`;
      }
      addTrace({
        ...ctx, actor: 'trulioo', title: omit ? 'Generate signed URL WITHOUT endClientId' : 'Generate signed URL bound to the session',
        request: r.request, response: r.response, note,
      });
      break;
    }
    default:
      throw new Error('unknown step');
  }
  c.stepsDone.add(n);
}

function newCustomer(crid, customerName, faults) {
  const c = {
    crid, customerName, session: null, elementId: null, flowResp: null,
    signedUrl: null, signedSession: null, omit: false, status: 'NOT_STARTED',
    stepsDone: new Set(), lookupFailed: false, blocked: null,
    faults: new Set(Array.isArray(faults) ? faults : []),
  };
  S.customers.set(crid, c);
  return c;
}

const seek = express.Router();

// One step at a time (guided mode). Step 0 (re)starts the customer's run.
seek.post('/api/step', async (req, res) => {
  const { crid, customerName, n, faults } = req.body || {};
  if (!crid || !Number.isInteger(n)) return res.status(400).json({ error: 'crid and n required' });
  let c = S.customers.get(crid);
  if (n === 0) c = newCustomer(crid, customerName || crid, faults);
  if (!c) return res.status(400).json({ error: 'run step 0 first' });
  if (Array.isArray(faults)) c.faults = new Set(faults); // faults can be ticked mid-run
  if (c.blocked) return res.status(409).json({ error: c.blocked });
  if (n > 6 || c.stepsDone.has(n) || (n > 0 && !c.stepsDone.has(n - 1))) {
    return res.status(400).json({ error: `step ${n} is not next` });
  }
  try {
    await runStep(c, n);
    res.json({ ok: true, signedUrl: c.signedUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The whole CORRECT flow in one call (steps 0-6).
seek.post('/api/start-verification', async (req, res) => {
  const { customerName, crid, faults } = req.body || {};
  if (!crid) return res.status(400).json({ error: 'crid required' });
  const c = newCustomer(crid, customerName || crid, faults);
  try {
    for (let n = 0; n <= 6 && !c.blocked; n++) await runStep(c, n);
    res.json({ signedUrl: c.signedUrl, session: c.session });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Trulioo -> SEEK events. Return 200 immediately; do the work afterwards.
seek.post('/webhook', (req, res) => {
  res.status(200).json({ received: true });
  const myEpoch = getEpoch();
  setImmediate(() => handleWebhook(req.body || {}, myEpoch).catch((e) => console.error('webhook error', e)));
});

async function handleWebhook(evt, myEpoch) {
  const id = evt.id;
  const type = evt.event && evt.event.type;
  const userId = evt.event && evt.event.userId;
  const row = { ts: Date.now(), id, type, userId, crid: null, result: '', loop: false };
  S.events.push(row);
  if (S.events.length > 60) S.events.shift();

  // Dedupe on event id (webhooks can be delivered more than once).
  if (S.seen.has(id)) { row.result = 'duplicate event id, ignored'; return; }
  S.seen.add(id);

  // CRID lookup by x-hf-session (event.userId). This is the whole point of the mapping table.
  const m = S.mapping.get(userId);
  const step = type === 'FLOW_START' ? 7 : type === 'FLOW_END' ? 8 : null;
  let cust = m ? S.customers.get(m.crid) : null;
  if (!cust) cust = [...S.customers.values()].find((c) => c.signedSession === userId) || null;

  let local;
  if (m) {
    row.crid = m.crid;
    m.status = type === 'FLOW_START' ? 'IN_PROGRESS' : type === 'FLOW_END' ? 'COMPLETED' : m.status;
    if (cust) cust.status = m.status;
    row.result = `found ${m.crid}, status -> ${m.status}`;
    local = `SELECT crid FROM verification_sessions WHERE hf_session = '${userId}'\n  -> ${m.crid}\nUPDATE status = '${m.status}'`;
  } else {
    S.orphans.set(userId, { type });
    row.result = 'NO MAPPING for this session';
    local = `SELECT crid FROM verification_sessions WHERE hf_session = '${userId}'\n  -> (no row)\n\nSEEK cannot tell which customer this is.`;
    if (cust) cust.lookupFailed = true;
  }

  if (cust && step) {
    cust.stepsDone.add(step);
    addTrace({
      step, crid: cust.crid, actor: 'trulioo',
      title: `Webhook ${type} arrives at SEEK`,
      request: { method: 'POST', url: `${PUBLIC}/seek/webhook`, headers: { 'content-type': 'application/json' }, body: evt },
      response: { status: 200, headers: {}, body: { received: true } },
      local,
      note: m ? null : 'LOOKUP FAILED: this session was never stored by SEEK (see step 6).',
    });
  }

  if (S.broken) {
    // BUG: the handler "refreshes" the flow by calling GET flow with no
    // x-hf-session. That creates a NEW session, which fires a NEW FLOW_START,
    // which hits this handler again...
    row.loop = true;
    if (S.loop.created >= S.loop.cap) {
      S.loop.tripped = true;
      row.result += ' | SAFETY CAP reached, handler stopped';
      return;
    }
    S.loop.created++;
    const tok = await getToken();
    const r = await callTrulioo('GET', `/trulioo/wfs/interpreter-v2/flow/${FLOW_ID}`, {
      headers: { ...auth(tok), 'x-demo-fire-start': '1' }, // demo shim, see PART 1
    });
    if (myEpoch !== getEpoch()) return;
    row.result += ` | BUG: GET flow w/o x-hf-session created ${r.headers['x-hf-session']}`;
    return;
  }

  // CORRECT: on FLOW_END fetch the results via the export query (by session id).
  // Never touches the flow endpoints.
  if (type === 'FLOW_END' && m && cust) {
    const tok = await getToken();
    const r = await callTrulioo('GET', `/trulioo/wfs/export/v2/query/client/${userId}`, { headers: auth(tok) });
    if (myEpoch !== getEpoch()) return;
    addTrace({ step: 8, crid: cust.crid, actor: 'trulioo', title: 'SEEK fetches the results with the export query', request: r.request, response: r.response });
    row.result += ' | results fetched';
  }
}

seek.post('/api/mode', (req, res) => {
  const broken = !!(req.body && req.body.broken);
  if (broken && !S.broken) S.loop = { created: 0, cap: S.loop.cap, tripped: false };
  S.broken = broken;
  res.json({ broken });
});

seek.post('/api/reset', (req, res) => {
  const ws = cur();
  ws.epoch++;
  ws.T = freshTrulioo();
  ws.S = freshSeek();
  res.json({ ok: true });
});

seek.get('/api/state', (req, res) => {
  const customers = [...S.customers.values()].map((c) => ({
    crid: c.crid, customerName: c.customerName, session: c.session, signedUrl: c.signedUrl,
    signedSession: c.signedSession, omit: c.omit, status: c.status,
    stepsDone: [...c.stepsDone].sort((a, b) => a - b), lookupFailed: c.lookupFailed,
    blocked: c.blocked, faults: [...c.faults],
  }));
  const tsessions = [...T.sessions.values()].slice(-40).reverse().map((s) => ({
    id: s.id, crid: s.crid, status: s.done ? 'COMPLETED' : 'IN_PROGRESS',
  }));
  res.json({
    mode: S.broken ? 'BROKEN' : 'CORRECT',
    loop: S.loop,
    mapping: [...S.mapping].map(([session, m]) => ({ session, ...m })),
    orphans: [...S.orphans].map(([session, o]) => ({ session, type: o.type })),
    customers,
    trace: S.trace,
    events: S.events.slice(-30).reverse(),
    trulioo: { total: T.sessions.size, sessions: tsessions },
  });
});

app.use('/seek', seek);

/* ========================================================================== *
 * PART 3: STATIC FRONTEND
 * ========================================================================== */
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`MOCK DEMO (not Trulioo) running at ${PUBLIC}${DEMO_PASSWORD ? ' (password protected)' : ''}`);
});
