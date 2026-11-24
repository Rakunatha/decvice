// DecVice server: serves index.html and proxies AI calls so the API key never reaches the browser.
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const CODE = process.env.ACCESS_CODE || '';

const RULES = 'Use ONLY the provided case details and evidence. Do not invent facts, names, times or links. Every claim must cite evidence ids that exist in the input. State uncertainty and limitations. Never conclude guilt and never recommend arrest. Do not use caste, religion, gender, language, ethnicity or locality as grounds for any link or lead. Return strict JSON only, with no extra text.';
const SYS = {
  correlate: 'You are the Evidence Correlation Agent in a criminal investigation support tool. ' + RULES +
    ' Schema: {"entities":[{"id","type":"person|place|vehicle|phone|object|organisation","label"}],"links":[{"from","to","label","confidence":0-1,"evidence":["ids"]}],"timeline":[{"time","event","evidence":["ids"]}],"conflicts":["contradictions between items and gaps in evidence"],"insights":[{"title","evidence":["ids"],"reasoning":["steps"],"confidence":0-1,"limitations","change":"what new evidence would change this conclusion"}],"leads":[{"rank","lead","why","confidence":0-1}]}.' +
    ' Entities are people, places, vehicles, phone numbers and objects found in the evidence. If the same thing is written differently (for example a partial vehicle plate), link the entries with lower confidence. The timeline is chronological. Leads are suggestions for human review, not proof.',
  bias: 'You are the Bias-Audit Agent. ' + RULES +
    ' Check whether the analysis output relies on or is influenced by caste, religion, gender, language, ethnicity or locality. Schema: {"warnings":["string"],"summary":"string","risk":"low|medium|high"}.'
};

const hits = new Map();
const limited = ip => { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 60000); a.push(n); hits.set(ip, a); return a.length > 20; };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => { let b = '', n = 0; req.on('data', c => { n += c.length; if (n > 200000) { no(new Error('too large')); req.destroy(); } else b += c; }); req.on('end', () => ok(b)); req.on('error', no); });

http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"
      });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (req.method === 'POST' && req.url === '/api/ai') {
      if (CODE && req.headers['x-access-code'] !== CODE) return send(res, 401, { error: 'access code required' });
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
      if (limited(ip)) return send(res, 429, { error: 'too many requests, wait a minute' });
      if (!KEY) return send(res, 503, { error: 'AI is not configured on the server' });
      let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad request' }); }
      if (!SYS[body.task] || typeof body.payload !== 'object') return send(res, 400, { error: 'unknown task' });
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ model: MODEL, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: SYS[body.task] }, { role: 'user', content: JSON.stringify(body.payload) }] }),
        signal: AbortSignal.timeout(50000)
      }).catch(() => null);
      if (!r) return send(res, 504, { error: 'the AI service did not respond in time' });
      if (r.status === 401) return send(res, 502, { error: 'the server API key was rejected' });
      if (r.status === 429) return send(res, 429, { error: 'AI rate limit reached, try again shortly' });
      if (!r.ok) return send(res, 502, { error: 'AI service error ' + r.status });
      const j = await r.json();
      let out; try { out = JSON.parse(j.choices[0].message.content); } catch (e) { return send(res, 502, { error: 'the AI returned malformed output' }); }
      return send(res, 200, { result: out });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: 'server error' }); }
}).listen(PORT, () => console.log('DecVice listening on ' + PORT));
