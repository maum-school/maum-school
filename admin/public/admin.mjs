import { calendarWeeks, cleanPost, limits, schoolDate, validMonth, weekdays, website } from '/school-content.mjs';

const byId = id => document.getElementById(id);
const fields = byId('fields');
const preview = byId('preview');
const month = byId('month');
let content = { posts: [] };
let sha;
let draft;
let dirty = false;
let busy = false;
let conflicted = false;
let pending;
let publication;
const monthEvents = new Map();

function status(message, error = false) {
  const el = byId('status');
  el.textContent = message;
  el.toggleAttribute('data-error', error);
}

async function api(path, payload) {
  const options = { cache: 'no-store', redirect: 'error' };
  if (payload) Object.assign(options, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('연결이 끊겼거나 로그인이 만료됐습니다. 작성 내용을 복사한 뒤 관리자 주소를 새로 열어 주세요.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
  return data;
}

function setBusy(value) {
  busy = value;
  fields.disabled = busy || !sha;
  for (const id of ['reload', 'new-notice', 'new-schedule', 'publish', 'close-preview', 'check-live']) {
    byId(id).disabled = busy;
  }
}

function showPosts() {
  const list = byId('posts');
  list.replaceChildren();
  byId('empty-list').hidden = !!content.posts.length;
  byId('empty-list').textContent = '발행한 게시글이 없습니다.';
  for (const post of content.posts) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = post.title;
    if (post.id === draft?.id) button.setAttribute('aria-current', 'true');
    const small = document.createElement('small');
    small.textContent = post.kind === 'schedule' ? post.month + ' 학사일정' : post.board + ' · ' + post.date;
    button.append(small);
    button.addEventListener('click', () => {
      if (!busy && discardChanges()) edit(post);
    });
    item.append(button);
    list.append(item);
  }
}

function discardChanges() {
  return !dirty || window.confirm('현재 작성 중인 내용을 지우고 다른 게시글을 열까요?');
}

function calendar(target, value, events, editable) {
  target.replaceChildren();
  if (!validMonth(value)) return;
  const scroller = document.createElement('div');
  scroller.className = 'calendar-scroll';
  const table = document.createElement('table');
  table.setAttribute('aria-label', value + ' 평일 달력');
  const heading = table.createTHead().insertRow();
  for (const weekday of weekdays) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = weekday;
    heading.append(th);
  }
  const tbody = table.createTBody();
  for (const week of calendarWeeks(value)) {
    const row = tbody.insertRow();
    for (const day of week) {
      const cell = row.insertCell();
      if (!day) continue;
      if (!editable) {
        cell.textContent = day + (events[day] ? '\n' + events[day] : '');
        continue;
      }
      const label = document.createElement('label');
      label.htmlFor = 'day-' + day;
      label.textContent = day + '일';
      const input = document.createElement('textarea');
      input.id = label.htmlFor;
      input.rows = 2;
      input.maxLength = limits.event;
      input.value = events[day] || '';
      input.addEventListener('input', () => { events[day] = input.value; });
      cell.append(label, input);
    }
  }
  scroller.append(table);
  target.append(scroller);
}

function monthTitle(value) {
  const [year, number] = value.split('-').map(Number);
  return year + '년 ' + number + '월 학사일정';
}

function edit(post) {
  draft = { ...post };
  dirty = false;
  conflicted = false;
  status('');
  monthEvents.clear();
  const schedule = post.kind === 'schedule';
  byId('editor-title').textContent = (post.revision ? '발행한 ' : '새 ') + (schedule ? '학사일정' : '공지');
  byId('notice-fields').hidden = schedule;
  byId('schedule-fields').hidden = !schedule;
  byId('delete').hidden = !post.revision;
  byId('body-label').textContent = schedule ? '추가 안내' : '본문';
  byId('body').required = !schedule;
  byId('body').value = post.body || '';
  byId('title').value = post.title || '';
  byId('board').value = post.board || '학부모게시판';
  byId('pinned').checked = !!post.pinned;
  month.value = post.month || schoolDate().slice(0, 7);
  month.required = schedule;
  if (schedule) {
    monthEvents.set(month.value, { ...post.events });
    calendar(byId('calendar'), month.value, monthEvents.get(month.value), true);
  }
  showPosts();
}

function create(kind) {
  const date = schoolDate();
  const value = date.slice(0, 7);
  edit({ id: crypto.randomUUID(), kind, date, month: value, title: kind === 'schedule' ? monthTitle(value) : '' });
}

function formPost() {
  return cleanPost({
    id: draft.id, kind: draft.kind, date: draft.date, title: byId('title').value, body: byId('body').value,
    board: byId('board').value, pinned: byId('pinned').checked, month: month.value, events: monthEvents.get(month.value)
  });
}

async function checkLive() {
  if (!publication) return;
  const target = publication;
  const out = byId('publication-status');
  const button = byId('check-live');
  button.disabled = true;
  try {
    const query = new URLSearchParams({ id: target.id, revision: target.revision || 'deleted' });
    const result = await api('/api/live?' + query);
    if (publication !== target) return;
    out.textContent = result.applied
      ? (target.revision ? '홈페이지 반영을 확인했습니다.' : '홈페이지에서 삭제된 것을 확인했습니다.')
      : 'GitHub에 저장됐습니다. 홈페이지 배포를 기다리는 중입니다.';
    byId('open-post').hidden = !(result.applied && target.revision);
    if (!result.applied && Date.now() < target.checkUntil) setTimeout(() => {
      if (publication === target) checkLive();
    }, 8000);
  } catch (error) {
    if (publication === target) out.textContent = error.message;
  } finally {
    if (publication === target) button.disabled = false;
  }
}

async function save(action, post) {
  setBusy(true);
  byId('preview-error').hidden = true;
  try {
    const saved = await api('/api/content', { action, id: draft.id, sha, post });
    content = saved.content;
    sha = saved.sha;
    dirty = false;
    if (preview.open) preview.close();
    if (action === 'delete') create(draft.kind);
    else edit(content.posts.find(item => item.id === saved.id));
    status('');
    publication = { id: saved.id, revision: saved.revision, checkUntil: Date.now() + 120000 };
    byId('publication').hidden = false;
    byId('publication-status').textContent = 'GitHub에 저장됐습니다. 홈페이지 배포를 확인하는 중입니다.';
    byId('open-post').href = saved.revision ? website + '/?publication=' + saved.revision + '#school_' + saved.id : '';
    byId('open-post').hidden = true;
  } catch (error) {
    if (preview.open) {
      byId('preview-error').textContent = error.message;
      byId('preview-error').hidden = false;
    } else {
      status(error.message, true);
    }
    return;
  } finally {
    setBusy(false);
  }
  await checkLive();
}

async function reload() {
  setBusy(true);
  try {
    const data = await api('/api/content');
    status('');
    byId('account').textContent = data.email;
    sha = data.sha;
    content = data.content;
    if (!draft) create('notice');
    else if (!dirty) {
      const saved = content.posts.find(post => post.id === draft.id);
      if (saved) edit(saved);
      else if (draft.revision) create(draft.kind);
    } else if (draft.revision !== content.posts.find(post => post.id === draft.id)?.revision) {
      status('이 글이 다른 곳에서 수정됐습니다. 작성 내용을 복사한 뒤 목록에서 다시 여세요.', true);
      conflicted = true;
    }
    showPosts();
  } catch (error) {
    status(error.message, true);
  } finally {
    setBusy(false);
  }
}

byId('editor-form').addEventListener('input', () => { dirty = true; });
month.addEventListener('change', () => {
  if (!validMonth(month.value)) return;
  if (!monthEvents.has(month.value)) monthEvents.set(month.value, {});
  if (!byId('title').value || /^20\d\d년 \d{1,2}월 학사일정$/.test(byId('title').value)) byId('title').value = monthTitle(month.value);
  calendar(byId('calendar'), month.value, monthEvents.get(month.value), true);
});
byId('editor-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!sha || busy) return;
  if (conflicted) {
    status('다른 곳에서 수정된 글입니다. 작성 내용을 복사한 뒤 목록에서 다시 여세요.', true);
    return;
  }
  try {
    pending = formPost();
    byId('preview-meta').textContent = pending.kind === 'schedule' ? pending.month + ' · 학사일정' : pending.board + ' · ' + pending.date;
    byId('preview-title').textContent = pending.title;
    byId('preview-body').textContent = pending.body;
    calendar(byId('preview-calendar'), pending.month, pending.events, false);
    byId('preview-error').hidden = true;
    preview.showModal();
  } catch (error) {
    status(error.message, true);
  }
});
preview.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
byId('publish').addEventListener('click', () => { if (!busy) save('save', pending); });
byId('close-preview').addEventListener('click', () => preview.close());
byId('delete').addEventListener('click', () => {
  if (conflicted) {
    status('다른 곳에서 수정된 글입니다. 목록에서 다시 여세요.', true);
    return;
  }
  if (!busy && window.confirm('이 게시글을 공개 홈페이지에서 삭제할까요?')) save('delete');
});
byId('check-live').addEventListener('click', checkLive);
byId('reload').addEventListener('click', reload);
byId('new-notice').addEventListener('click', () => { if (!busy && discardChanges()) create('notice'); });
byId('new-schedule').addEventListener('click', () => { if (!busy && discardChanges()) create('schedule'); });
window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });
reload();
