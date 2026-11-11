export const contentPath = 'school-content.json';
export const website = 'https://mdschool.or.kr';
export const weekdays = ['월', '화', '수', '목', '금'];
export const noticeBoards = ['학부모게시판', '학생게시판', '교사게시판'];
export const limits = { title: 100, body: 5000, event: 160, file: 500_000 };

export const validId = (value) => typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const validMonth = (value) => typeof value === 'string' && /^20\d\d-(0[1-9]|1[0-2])$/.test(value);
const validDate = (value) => typeof value === 'string' && validMonth(value.slice(0, 7)) &&
  /^20\d\d-\d\d-\d\d$/.test(value) && !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

export function schoolDate() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function calendarWeeks(month) {
  if (!validMonth(month)) return [];
  const [year, number] = month.split('-').map(Number);
  const length = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const weeks = [];
  let week = Array(5).fill(null);
  for (let day = 1; day <= length; day++) {
    const weekday = new Date(Date.UTC(year, number - 1, day)).getUTCDay();
    if (weekday >= 1 && weekday <= 5) week[weekday - 1] = day;
    if ((weekday === 5 || day === length) && week.some(Boolean)) {
      weeks.push(week);
      week = Array(5).fill(null);
    }
  }
  return weeks;
}

function cleanText(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new Error(label + ' 내용을 확인해 주세요. 최대 ' + max + '자입니다.');
  }
  return value.trim();
}

export function cleanPost(input) {
  if (!validId(input?.id) || !validDate(input.date)) throw new Error('게시글 번호 또는 날짜를 확인해 주세요.');
  const fields = {
    id: input.id,
    title: cleanText(input.title, limits.title, '제목', true),
    date: input.date,
    body: cleanText(input.body, limits.body, '본문', input.kind === 'notice')
  };
  if (input.kind === 'notice' && noticeBoards.includes(input.board)) {
    return { ...fields, kind: 'notice', board: input.board, pinned: input.pinned === true };
  }
  if (input.kind !== 'schedule' || !validMonth(input.month)) throw new Error('게시판 또는 일정의 연월을 확인해 주세요.');
  const days = new Set(calendarWeeks(input.month).flat().filter(Boolean).map(String));
  if (!input.events || typeof input.events !== 'object' || Array.isArray(input.events)) {
    throw new Error('달력 입력을 확인해 주세요.');
  }
  const events = {};
  for (const [day, value] of Object.entries(input.events)) {
    if (!days.has(day)) throw new Error('달력에 없는 날짜의 일정이 포함되어 있습니다.');
    const event = cleanText(value, limits.event, day + '일 일정');
    if (event) events[day] = event;
  }
  if (!Object.keys(events).length && !fields.body) throw new Error('달력 일정이나 안내를 입력해 주세요.');
  return { ...fields, kind: 'schedule', month: input.month, events };
}

export function readContent(value) {
  if (value?.version !== 1 || !Array.isArray(value.posts)) throw new Error('학교 게시글 파일 형식이 올바르지 않습니다.');
  const posts = value.posts.map((post) => {
    if (!validId(post.revision)) throw new Error('학교 게시글 버전이 올바르지 않습니다.');
    return { ...cleanPost(post), revision: post.revision };
  });
  if (new Set(posts.map(post => post.id)).size !== posts.length) throw new Error('중복 게시글이 있습니다.');
  return { version: 1, posts };
}

export function toWebsitePost(post) {
  const paragraphs = post.body.split(/\r?\n/).map(text => ({ text }));
  const blocks = [];
  let summary = post.body.slice(0, 150);
  if (post.kind === 'schedule') {
    const [year, month] = post.month.split('-').map(Number);
    summary = year + '년 ' + month + '월 월간 학사일정';
    const header = weekdays.map(v => ({ v, bg: '#fff8b2' }));
    const rows = calendarWeeks(post.month).map(week => week.map(day => ({
      v: day ? [String(day), post.events[day]].filter(Boolean).join('\n') : ''
    })));
    blocks.push({ t: 'table', rows: [header, ...rows] });
  }
  if (post.body) blocks.push({ t: 'paragraphs', paras: paragraphs });
  return {
    id: 'school_' + post.id, cat: post.kind === 'notice' ? post.board : '학교일정',
    title: post.title, date: post.kind === 'schedule' ? post.month + '-01' : post.date,
    author: '마음더하기학교', summary, thumb: '', pinned: !!post.pinned, blocks, isCustom: true
  };
}
