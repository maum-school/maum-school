import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { test } from 'node:test';
import worker from './worker.mjs';
import { calendarWeeks, readContent, toWebsitePost } from './public/school-content.mjs';

test('공지와 월간 일정을 승인된 계정으로 발행하고 실제 배포 파일로 반영을 확인한다', async (t) => {
  const accessKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const env = {
    ACCESS_TEAM_URL: 'https://maum-test.cloudflareaccess.com',
    ACCESS_AUDIENCE: 'admin-test',
    ADMIN_EMAILS: 'teacher@example.test',
    GITHUB_APP_ID: 'test-app',
    GITHUB_INSTALLATION_ID: '1',
    GITHUB_APP_PRIVATE_KEY: appKeys.privateKey.export({ format: 'pem', type: 'pkcs1' }),
    ASSETS: { fetch: () => new Response('admin') }
  };
  const admin = 'https://admin.example.test';
  const github = 'https://api.github.com';
  const file = github + '/repos/maum-school/maum-school/contents/school-content.json';
  const jwk = { ...accessKeys.publicKey.export({ format: 'jwk' }), kid: 'access-test', alg: 'RS256' };
  const shaFor = count => String(count).padStart(40, '0');
  let content = { version: 1, posts: [] };
  let live = structuredClone(content);
  let writes = 0;
  let rejectNextWrite = false;
  let tokenRequests = 0;

  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url === env.ACCESS_TEAM_URL + '/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
    const auth = options.headers?.Authorization;
    if (url === github + '/app/installations/1/access_tokens') {
      const [head, body, signature] = auth.slice(7).split('.');
      assert.ok(verify('RSA-SHA256', Buffer.from(head + '.' + body), appKeys.publicKey, Buffer.from(signature, 'base64url')));
      assert.deepEqual(JSON.parse(options.body), { repositories: ['maum-school'], permissions: { contents: 'write' } });
      tokenRequests++;
      return Response.json({ token: 'test-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    if (url === file + '?ref=main') {
      assert.equal(auth, 'Bearer test-installation-token');
      const raw = Buffer.from(JSON.stringify(content));
      return Response.json({ content: raw.toString('base64'), encoding: 'base64', sha: shaFor(writes), size: raw.length });
    }
    if (url === file && options.method === 'PUT') {
      assert.equal(auth, 'Bearer test-installation-token');
      const write = JSON.parse(options.body);
      assert.equal(write.sha, shaFor(writes));
      assert.equal(write.branch, 'main');
      if (rejectNextWrite) {
        rejectNextWrite = false;
        return new Response('', { status: 409 });
      }
      content = JSON.parse(Buffer.from(write.content, 'base64').toString());
      writes++;
      return Response.json({ content: { sha: shaFor(writes) } });
    }
    if (url.startsWith('https://mdschool.or.kr/school-content.json?')) return Response.json(live);
    throw new Error('Unexpected fetch: ' + url);
  });

  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  function accessToken(claims = {}, key = accessKeys.privateKey) {
    const head = part({ alg: 'RS256', kid: jwk.kid });
    const body = part({
      iss: env.ACCESS_TEAM_URL, aud: [env.ACCESS_AUDIENCE], exp: Math.floor(Date.now() / 1000) + 120,
      email: 'teacher@example.test', ...claims
    });
    return head + '.' + body + '.' + sign('RSA-SHA256', Buffer.from(head + '.' + body), key).toString('base64url');
  }
  const token = accessToken();
  const call = (path, access = token, payload, origin = admin) => worker.fetch(new Request(admin + path, {
    method: payload ? 'POST' : 'GET',
    headers: {
      ...(access ? { 'Cf-Access-Jwt-Assertion': access } : {}),
      ...(payload ? { Origin: origin, 'Content-Type': 'application/json' } : {})
    },
    body: payload ? JSON.stringify(payload) : undefined
  }), env);

  assert.equal((await call('/', null)).status, 403);
  assert.equal((await call('/admin.mjs', null)).status, 403);
  assert.equal((await call('/api/content', accessToken({ aud: ['different-app'] }))).status, 403);
  assert.equal((await call('/api/content', accessToken({ email: 'outside@example.test' }))).status, 403);
  assert.equal((await call('/api/content', accessToken({ exp: 1 }))).status, 403);
  assert.equal((await call('/api/content', accessToken({}, appKeys.privateKey))).status, 403);
  assert.equal(tokenRequests, 0);
  assert.equal(await (await call('/')).text(), 'admin');
  assert.equal((await (await call('/api/content')).json()).sha, shaFor(0));

  const notice = {
    id: crypto.randomUUID(), kind: 'notice', title: '신규 공지', date: '2026-11-11',
    board: '학부모게시판', body: '첫 줄\n둘째 줄', pinned: true
  };
  const save = (post, base = shaFor(writes), origin = admin) =>
    call('/api/content', token, { action: 'save', id: post.id, sha: base, post }, origin);
  assert.equal((await save(notice, shaFor(0), 'https://outside.example.test')).status, 403);
  assert.equal((await save({ ...notice, date: '2026-02-30' })).status, 400);
  assert.equal((await save(notice)).status, 200);
  assert.equal((await save(notice, shaFor(0))).status, 409);
  rejectNextWrite = true;
  assert.equal((await save({ ...notice, title: '수정된 공지' })).status, 409);
  assert.equal(content.posts[0].title, notice.title);
  assert.equal((await save({ ...notice, title: '수정된 공지' })).status, 200);

  const schedule = {
    id: crypto.randomUUID(), kind: 'schedule', title: '12월 일정', date: '2026-11-11', month: '2026-12',
    events: { 1: '수업', 25: '휴일' }, body: '준비물 안내'
  };
  assert.deepEqual(calendarWeeks('2026-12')[0], [null, 1, 2, 3, 4]);
  assert.equal((await save({ ...schedule, events: { 5: '토요일' } })).status, 400);
  assert.equal((await save(schedule)).status, 200);
  assert.equal((await save({ ...schedule, id: crypto.randomUUID() })).status, 409);
  const published = readContent(content).posts.map(toWebsitePost);
  assert.equal(published[0].cat, '학교일정');
  assert.equal(published[0].blocks[0].rows[1][1].v, '1\n수업');
  assert.deepEqual(published[1].blocks[0].paras.map(p => p.text), ['첫 줄', '둘째 줄']);

  const revision = content.posts[0].revision;
  const liveUrl = '/api/live?id=' + schedule.id + '&revision=';
  assert.equal((await (await call(liveUrl + revision)).json()).applied, false);
  live = structuredClone(content);
  assert.equal((await (await call(liveUrl + revision)).json()).applied, true);
  assert.equal((await call('/api/content', token, { action: 'delete', id: schedule.id, sha: shaFor(writes) })).status, 200);
  assert.equal((await (await call(liveUrl + 'deleted')).json()).applied, false);
  live = structuredClone(content);
  assert.equal((await (await call(liveUrl + 'deleted')).json()).applied, true);
  assert.equal(content.posts.length, 1);
  assert.equal(tokenRequests, 1);
});
