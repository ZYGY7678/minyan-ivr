import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

process.env.PORT = '31988';
process.env.YM_TOKEN = 'test-token';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.RADIUS_KM = '2';
delete process.env.KEEP_ALIVE;
delete process.env.RENDER_EXTERNAL_URL;

const externalCalls = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  externalCalls.push({ url, method: init.method || 'GET' });

  if (url.includes('/ym/api/DownloadFile')) {
    return new Response(new Uint8Array([0, 1, 2, 3, 4, 5]), {
      status: 200, headers: { 'content-type': 'audio/wav' }
    });
  }
  if (url.includes('/openai/v1/audio/transcriptions')) {
    return Response.json({ text: 'בני ברק רבי עקיבא' });
  }
  if (url.includes('nominatim.openstreetmap.org/search')) {
    return Response.json([{
      lat: '32.0833', lon: '34.8333',
      address: { country_code: 'il', country: 'Israel' }
    }]);
  }
  if (url.includes('photon.komoot.io')) {
    return Response.json({ features: [] });
  }
  if (url.includes('www.matara.pro/nedarimplus/Zmanim/Manage.aspx')) {
    return Response.json([{ T: 'שחרית', L: 'בית כנסת לבדיקה', H: '23:59', D: 100 }]);
  }
  return new Response('Unexpected mocked URL: ' + url, { status: 500 });
};

await import('../server.js');
await delay(250);

function request(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 31988, path, method
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'],
        body
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

try {
  const health = await request('/healthz');
  assert.equal(health.status, 200, 'readiness endpoint must report configured service');
  assert.match(health.body, /"status":"ok"/, 'readiness endpoint must report ok');

  const initial = await request('/ivr');
  assert.equal(initial.status, 200, 'initial IVR request must return HTTP 200');
  assert.match(initial.body, /^read=t-/, 'initial response must ask caller to record an address');

  const prompt = await request('/ivr?ApiCallId=ci-smoke&voiceFile=recording.wav');
  assert.equal(prompt.status, 200, 'recording callback must return HTTP 200');
  assert.match(prompt.body, /confirmAddress1/, 'recording callback must ask for address confirmation');
  assert.match(prompt.body, /confirmAddress1,no,1,1,20,No/, 'keypad read command must use documented field order');
  assert.doesNotMatch(prompt.body, /,no,tap,/, 'unsupported extra tap field must not be emitted');

  const result = await request('/ivr?ApiCallId=ci-smoke&voiceFile=recording.wav&confirmAddress1=1');
  assert.equal(result.status, 200, 'confirmation callback must return HTTP 200');
  assert.match(result.body, /^id_list_message=t-/, 'successful lookup must return a Yemot playback command');
  assert.match(result.body, /בית כנסת לבדיקה/, 'response must contain the mocked minyan result');

  const hosts = new Set(externalCalls.map(x => new URL(x.url).host));
  for (const expected of [
    'www.call2all.co.il',
    'api.groq.com',
    'nominatim.openstreetmap.org',
    'www.matara.pro'
  ]) assert.ok(hosts.has(expected), 'expected mocked integration was not called: ' + expected);

  console.log('PASS: syntax-independent IVR smoke flow (initial prompt → transcription → keypad confirmation → minyan result)');
  console.log('PASS: mocked integrations called:', [...hosts].join(', '));
  process.exit(0);
} catch (error) {
  console.error('FAIL: IVR smoke test');
  console.error(error);
  process.exit(1);
}
