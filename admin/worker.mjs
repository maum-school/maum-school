import { createPrivateKey, sign } from 'node:crypto';
import { cleanPost, contentPath, limits, readContent, validId, website } from './public/school-content.mjs';

const github = 'https://api.github.com';
const repository = 'maum-school/maum-school';
const contentsUrl = github + '/repos/' + repository + '/contents/' + contentPath;
const shaPattern = /^[a-f0-9]{40}$/;
const responseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: responseHeaders });
}

function decode64(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
}

function jwtPart(value) {
  return JSON.parse(new TextDecoder().decode(decode64(value)));
}

let keysCache;
async function authorizedEmail(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const issuer = env.ACCESS_TEAM_URL;
  const audience = env.ACCESS_AUDIENCE;
  const emails = (env.ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!token || token.length > 16384 || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer || '') ||
      !audience || !emails.length) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, claims] = parts.slice(0, 2).map(jwtPart);
    const now = Math.floor(Date.now() / 1000);
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    if (header.alg !== 'RS256' || !header.kid || claims.iss !== issuer || !Array.isArray(claims.aud) ||
        !claims.aud.includes(audience) || !Number.isFinite(claims.exp) || claims.exp <= now ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now)) || !emails.includes(email)) return null;
    if (keysCache?.issuer !== issuer || keysCache.expires <= now || !keysCache.keys.some(key => key.kid === header.kid)) {
      const response = await fetch(issuer + '/cdn-cgi/access/certs', { redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!response.ok) return null;
      const { keys } = await response.json();
      keysCache = { issuer, keys, expires: now + 300 };
    }
    const jwk = keysCache.keys.find(key => key.kid === header.kid);
    if (!jwk) return null;
    const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    const key = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['verify']);
    const valid = await crypto.subtle.verify(algorithm.name, key, decode64(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    return valid ? email : null;
  } catch {
    return null;
  }
}

function githubRequest(url, token, options = {}) {
  return fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'maum-school-admin',
      ...options.headers
    }
  });
}

let installationToken;
async function githubToken(env) {
  if (!env.GITHUB_APP_ID || !/^\d+$/.test(env.GITHUB_INSTALLATION_ID || '') || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new HttpError(503, 'GitHub 발행 연결이 아직 설정되지 않았습니다.');
  }
  const cacheKey = env.GITHUB_APP_ID + ':' + env.GITHUB_INSTALLATION_ID;
  if (installationToken?.key === cacheKey && installationToken.expires > Date.now() + 60_000) return installationToken.value;
  const now = Math.floor(Date.now() / 1000);
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = part({ alg: 'RS256', typ: 'JWT' }) + '.' + part({ iss: env.GITHUB_APP_ID, iat: now - 60, exp: now + 540 });
  const key = createPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const jwt = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url');
  const response = await githubRequest(github + '/app/installations/' + env.GITHUB_INSTALLATION_ID + '/access_tokens', jwt, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositories: ['maum-school'], permissions: { contents: 'write' } })
  });
  if (!response.ok) throw new HttpError(502, 'GitHub 발행 권한을 확인할 수 없습니다.');
  const result = await response.json();
  installationToken = { key: cacheKey, value: result.token, expires: Date.parse(result.expires_at) };
  return installationToken.value;
}

async function getSchoolContent(token) {
  const response = await githubRequest(contentsUrl + '?ref=main', token);
  if (!response.ok) throw new HttpError(502, 'GitHub 게시글을 불러오지 못했습니다.');
  const record = await response.json();
  if (record.encoding !== 'base64' || !shaPattern.test(record.sha || '') || record.size > limits.file) {
    throw new HttpError(502, 'GitHub 게시글 파일을 확인할 수 없습니다.');
  }
  const value = JSON.parse(Buffer.from(record.content, 'base64').toString('utf8'));
  return { sha: record.sha, content: readContent(value) };
}

async function publish(request, token) {
  const origin = new URL(request.url).origin;
  if (request.headers.get('Origin') !== origin || request.headers.get('Sec-Fetch-Site') === 'cross-site' ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new HttpError(403, '관리자 화면에서 발행을 다시 눌러 주세요.');
  }
  let input;
  try {
    const source = await request.text();
    if (source.length > 40_000) throw new HttpError(413, '입력 크기가 너무 큽니다.');
    input = JSON.parse(source);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '발행 요청을 읽을 수 없습니다.');
  }
  if (!shaPattern.test(input?.sha || '') || !['save', 'delete'].includes(input?.action) || !validId(input.id)) {
    throw new HttpError(400, '발행 정보를 확인해 주세요.');
  }
  const record = await getSchoolContent(token);
  if (input.sha !== record.sha) throw new HttpError(409, '다른 변경이 먼저 저장되었습니다. 작성 내용은 현재 화면에 있습니다.');
  const posts = record.content.posts;
  const index = posts.findIndex(post => post.id === input.id);
  let revision = null;
  let title;
  if (input.action === 'delete') {
    if (index < 0) throw new HttpError(404, '삭제할 게시글이 없습니다.');
    title = posts[index].title;
    posts.splice(index, 1);
  } else {
    let post;
    try {
      post = cleanPost({ ...input.post, id: input.id });
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    if (post.kind === 'schedule' && posts.some(other => other.kind === 'schedule' && other.id !== post.id && other.month === post.month)) {
      throw new HttpError(409, '이 달에 이미 발행한 일정이 있습니다. 게시글 목록에서 해당 일정을 선택해 수정하세요.');
    }
    if (index >= 0 && posts[index].kind !== post.kind) throw new HttpError(400, '기존 글의 종류는 변경할 수 없습니다.');
    title = post.title;
    revision = crypto.randomUUID();
    if (index < 0) posts.unshift({ ...post, revision });
    else posts[index] = { ...post, revision };
  }

  const serialized = Buffer.from(JSON.stringify(record.content, null, 2) + '\n');
  if (serialized.length > limits.file) throw new HttpError(413, '게시글 파일의 최대 크기를 초과했습니다.');
  const response = await githubRequest(contentsUrl, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: (input.action === 'delete' ? '홈페이지 게시글 삭제: ' : '홈페이지 게시글 발행: ') + title.replace(/\s+/g, ' '),
      content: serialized.toString('base64'),
      sha: record.sha,
      branch: 'main'
    })
  });
  if ([409, 422].includes(response.status)) throw new HttpError(409, '저장 중 다른 변경이 발생했습니다. 게시글을 다시 불러와 확인해 주세요.');
  if (!response.ok) throw new HttpError(502, 'GitHub에 게시글을 저장하지 못했습니다.');
  const saved = await response.json();
  return json({ content: record.content, sha: saved.content.sha, id: input.id, revision });
}

async function live(url) {
  const id = url.searchParams.get('id');
  const revision = url.searchParams.get('revision');
  if (!validId(id) || (revision !== 'deleted' && !validId(revision))) throw new HttpError(400, '확인할 발행 번호가 올바르지 않습니다.');
  const response = await fetch(website + '/' + contentPath + '?check=' + crypto.randomUUID(), {
    signal: AbortSignal.timeout(8000), redirect: 'error', cache: 'no-store'
  });
  if (!response.ok) throw new HttpError(502, '공개 홈페이지의 반영 상태를 읽지 못했습니다.');
  const post = readContent(await response.json()).posts.find(item => item.id === id);
  return json({ applied: revision === 'deleted' ? !post : post?.revision === revision });
}

export default {
  async fetch(request, env) {
    const email = await authorizedEmail(request, env);
    if (!email) return json({ error: '등록된 교직원 계정으로 로그인해 주세요.' }, 403);
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/live' && request.method === 'GET') return await live(url);
      if (url.pathname === '/api/content' && request.method === 'GET') {
        return json({ ...await getSchoolContent(await githubToken(env)), email });
      }
      if (url.pathname === '/api/content' && request.method === 'POST') return await publish(request, await githubToken(env));
      if (url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method)) {
        return json({ error: '요청한 페이지가 없습니다.' }, 404);
      }
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      for (const [name, value] of Object.entries(responseHeaders)) response.headers.set(name, value);
      return response;
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error('Admin request failed', request.method, url.pathname, error.name);
      return json({ error: '요청을 처리하지 못했습니다. 게시글 목록을 새로 불러온 뒤 상태를 확인해 주세요.' }, 502);
    }
  }
};
