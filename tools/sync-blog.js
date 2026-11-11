#!/usr/bin/env node
/* =====================================================================
 * 네이버 블로그 → 홈페이지 동기화 스크립트 (tools/sync-blog.js)
 * ---------------------------------------------------------------------
 * 마음더하기학교 네이버 블로그(https://blog.naver.com/mdlove503)의
 * 카테고리·게시글(본문, 사진, 표, 첨부파일)을 읽어서
 * 홈페이지가 사용하는 blog-data.js 파일을 만들어 줍니다.
 *
 * ▶ 사용법 (maum-school 폴더에서 실행)
 *     node tools/sync-blog.js          ← 새 글만 추가로 가져오기 (빠름)
 *     node tools/sync-blog.js --full   ← 모든 글을 처음부터 다시 가져오기
 *
 * ▶ 필요 조건: Node.js 18 이상 (별도 설치 패키지 없음), 인터넷 연결
 * ===================================================================== */

const fs = require('fs');
const path = require('path');

const BLOG_ID = 'mdlove503';
const OUT_FILE = path.join(__dirname, '..', 'blog-data.js');
const FULL = process.argv.includes('--full');
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, asJson) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, Referer: `https://m.blog.naver.com/${BLOG_ID}` },
                signal: AbortSignal.timeout(20000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return asJson ? await res.json() : await res.text();
        } catch (e) {
            if (attempt === 3) throw new Error(`${url} → ${e.message}`);
            await sleep(1000 * attempt);
        }
    }
}

// ---------- HTML 정리 도우미 ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };
const decode = s => String(s || '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
        if (ENT[e.toLowerCase()] !== undefined) return ENT[e.toLowerCase()];
        if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return m;
    });
const stripTags = s => decode(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ');

// 문단(<p class="se-text-paragraph">)들을 줄 단위 텍스트로
function parseParagraphs(html) {
    const matches = [...html.matchAll(/<p class="se-text-paragraph([^"]*)"[^>]*>([\s\S]*?)<\/p>/g)];
    const paras = [];

    for (const m of matches) {
        const cls = m[1] || '';
        const isCenter = cls.includes('align-center');
        const isRight = cls.includes('align-right');
        const align = isCenter ? 'center' : (isRight ? 'right' : 'left');

        // 폰트 크기 클래스 추출 (m[1] 및 m[2] 전체에서 se-fs-fsXX 탐색)
        const fsMatch = (cls + ' ' + m[2]).match(/se-fs-(fs\d+)/);
        const size = fsMatch ? fsMatch[1] : 'fs13';

        // m[2] 내부의 모든 태그(중첩 span, hashtag, a 링크, b, strong 등)를 온전하게 제거하여 문장 전문 보존
        let pText = stripTags(m[2])
            .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
            .trimEnd();

        // 빈 줄이라도 줄바꿈용으로 보존 (빈 문단도 1개의 빈 줄)
        paras.push({
            text: pText,
            align,
            size
        });
    }

    // 연속된 빈 문단은 최대 2개로 압축
    const cleaned = [];
    let emptyCount = 0;
    for (const p of paras) {
        if (!p.text) {
            emptyCount++;
            if (emptyCount <= 2) cleaned.push(p);
        } else {
            emptyCount = 0;
            cleaned.push(p);
        }
    }
    return cleaned;
}

// 네이버 사진 주소를 적당한 크기(가로 800px)로 통일
const normImg = u => decode(u).replace(/\?type=[^"&]*/, '') + '?type=w800';

// ---------- 게시글 본문 파싱 ----------
function parsePost(html) {
    const start = html.indexOf('se-main-container');
    if (start < 0) return { blocks: [], images: [] };
    const body = html.slice(start);
    const parts = body.split(/<div class="se-component (?=se-)/).slice(1);
    const blocks = [];
    const images = [];
    const pushParagraphs = pList => {
        if (!pList || !pList.length) return;
        // 연속된 동일 align/size 문단들을 하나의 block 또는 개별 문단 배열로 보존
        blocks.push({ t: 'paragraphs', paras: pList });
    };
    for (const part of parts) {
        const type = (part.match(/^(se-[\w-]+)/) || [])[1];
        switch (type) {
            case 'se-text':
            case 'se-sectionTitle':
                pushParagraphs(parseParagraphs(part));
                break;
            case 'se-quotation': {
                let style = 'underline';
                if (part.includes('quotation_line')) style = 'line';
                else if (part.includes('quotation_underline')) style = 'underline';
                else if (part.includes('quotation_box') || part.includes('quotation_balloon')) style = 'box';
                else if (part.includes('quotation_quotes') || part.includes('se-l-default')) style = 'quotes';

                const quoteTextMatch = part.match(/<div class="se-module se-module-text se-quote">([\s\S]*?)<\/div>/);
                const citeTextMatch = part.match(/<div class="se-module se-module-text se-cite">([\s\S]*?)<\/div>/);

                const qParas = quoteTextMatch ? parseParagraphs(quoteTextMatch[1]) : [];
                const cParas = citeTextMatch ? parseParagraphs(citeTextMatch[1]) : [];

                const text = qParas.map(p => p.text).filter(Boolean).join('\n');
                const cite = cParas.map(p => p.text).filter(Boolean).join('\n');

                if (text || cite) {
                    blocks.push({ t: 'quote', style, text, cite });
                }
                break;
            }
            case 'se-image':
            case 'se-imageStrip':
            case 'se-imageGroup':
            case 'se-sticker': {
                if (type === 'se-sticker') {
                    const stickerImg = part.match(/<img[^>]+class="se-sticker-image[^"]*"[^>]*src="([^"]+)"/i) ||
                                       part.match(/<img[^>]+src="([^"]+)"[^>]*class="se-sticker-image[^"]*"/i) ||
                                       part.match(/<img[^>]+src="([^"]*storep-phinf\.pstatic\.net[^"]*)"/i);
                    if (stickerImg && stickerImg[1]) {
                        blocks.push({ t: 'sticker', v: decode(stickerImg[1]) });
                    }
                    break;
                }

                // 이미지 태그 및 data-width, data-height 추출
                const imgMatches = [...part.matchAll(/<img[^>]+class="se-image-resource[^"]*"[^>]*>/g)];
                const imgData = [];

                for (const m of imgMatches) {
                    const tag = m[0];
                    const src = (tag.match(/data-lazy-src="([^"]+)"/) || tag.match(/src="([^"]+)"/) || [])[1];
                    if (!src) continue;
                    const w = parseInt((tag.match(/data-width="(\d+)"/) || [])[1] || '0', 10);
                    const h = parseInt((tag.match(/data-height="(\d+)"/) || [])[1] || '0', 10);
                    imgData.push({ src: normImg(src), w, h });
                }

                if (imgData.length > 1 || type === 'se-imageStrip' || type === 'se-imageGroup') {
                    let layout = 'col-' + imgData.length;
                    if (part.includes('se-imageStrip-col-2')) layout = 'col-2';
                    else if (part.includes('se-imageStrip-col-3')) layout = 'col-3';
                    else if (part.includes('se-imageGroup') || imgData.length === 4) layout = 'grid-4';
                    else if (imgData.length === 2) layout = 'col-2';
                    else if (imgData.length === 3) layout = 'col-3';

                    blocks.push({
                        t: 'image_group',
                        layout,
                        images: imgData.map(d => d.src),
                        meta: imgData.map(d => ({ w: d.w, h: d.h }))
                    });
                    for (const d of imgData) images.push(d.src);
                } else if (imgData.length === 1) {
                    blocks.push({ t: 'img', v: imgData[0].src });
                    images.push(imgData[0].src);
                }

                const cap = part.match(/<div class="se-module se-module-text se-caption">([\s\S]*?)<\/div>/);
                if (cap) pushParagraphs(parseParagraphs(cap[1]));
                break;
            }
            case 'se-table': {
                const rows = [...part.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(tr =>
                    [...tr[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(td => {
                        const bg = (td[1].match(/background-color:\s*(#[0-9a-fA-F]{3,6})/) || [])[1];
                        const cell = { v: stripTags(td[2]).trim() };
                        const cs = +((td[1].match(/colspan="(\d+)"/) || [])[1] || 1);
                        const rs = +((td[1].match(/rowspan="(\d+)"/) || [])[1] || 1);
                        if (cs > 1) cell.cs = cs;
                        if (rs > 1) cell.rs = rs;
                        if (bg && !/^#f{3}(f{3})?$/i.test(bg)) cell.bg = bg;
                        return cell;
                    }));
                if (rows.length) blocks.push({ t: 'table', rows });
                break;
            }
            case 'se-file': {
                const name = stripTags((part.match(/<span class="se-file-name">([\s\S]*?)<\/span>/) || [])[1]) +
                    stripTags((part.match(/<span class="se-file-extension">([\s\S]*?)<\/span>/) || [])[1]);
                const url = decode((part.match(/href="(https:\/\/download\.blog\.naver\.com[^"]+)"/) || [])[1] || '');
                if (name) blocks.push({ t: 'file', name, url });
                break;
            }
            case 'se-oglink': {
                const url = decode((part.match(/href="([^"]+)"/) || [])[1] || '');
                const title = stripTags((part.match(/<strong class="se-oglink-title">([\s\S]*?)<\/strong>/) || [])[1]).trim();
                if (url) blocks.push({ t: 'link', url, title: title || url });
                break;
            }
            case 'se-video':
            case 'se-oembed':
                blocks.push({ t: 'video' });
                break;
            case 'se-horizontalLine':
                blocks.push({ t: 'hr' });
                break;
            default:
                break; // 제목(se-documentTitle) 등은 무시
        }
    }
    return { blocks, images };
}

// ---------- 기존 데이터 읽기 ----------
function loadExisting() {
    if (!fs.existsSync(OUT_FILE)) return null;
    const txt = fs.readFileSync(OUT_FILE, 'utf8');
    return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
}

(async () => {
    console.log(`📥 네이버 블로그(${BLOG_ID}) 동기화 시작 ${FULL ? '(전체 다시 받기)' : '(새 글만)'}`);
    const previous = loadExisting();
    const existing = new Map(FULL ? [] : (previous?.posts || []).map(p => [p.id, p]));

    // 1) 카테고리 목록
    const catRes = await get(`https://m.blog.naver.com/api/blogs/${BLOG_ID}/category-list`, true);
    const cats = catRes.result.mylogCategoryList
        .filter(c => !c.divisionLine && c.categoryNo !== 0)
        .map(c => ({ no: c.categoryNo, name: c.categoryName, parent: c.parentCategoryNo || null, count: c.postCnt }));
    const parentNos = new Set(cats.map(c => c.parent).filter(Boolean));
    console.log(`📂 카테고리 ${cats.length}개: ${cats.map(c => `${c.name}(${c.count})`).join(', ')}`);

    // 2) 카테고리별 글 목록 (하위 카테고리 우선)
    const list = new Map();
    const ordered = [...cats].sort((a, b) => (parentNos.has(a.no) ? 1 : 0) - (parentNos.has(b.no) ? 1 : 0));
    for (const c of ordered) {
        for (let page = 1; page <= 100; page++) {
            const r = await get(`https://m.blog.naver.com/api/blogs/${BLOG_ID}/post-list?categoryNo=${c.no}&itemCount=30&page=${page}`, true);
            const items = r.result?.items;
            if (!Array.isArray(items)) throw new Error(`카테고리 ${c.no} 글 목록 응답이 올바르지 않습니다.`);
            for (const it of items) {
                if (it.allOpenPost !== true || it.categoryBlockYn === true) continue;
                const id = String(it.logNo);
                if (!/^\d+$/.test(id)) throw new Error('공개 글 목록에 올바르지 않은 게시글 번호가 있습니다.');
                if (list.has(id)) continue; // 하위 카테고리에서 이미 받은 글
                list.set(id, {
                    id,
                    cat: c.name,
                    title: decode(it.titleWithInspectMessage).trim(),
                    date: new Date(it.addDate + 9 * 3600 * 1000).toISOString().slice(0, 10),
                    summary: decode(it.briefContents || '').trim(),
                    thumb: it.thumbnailUrl ? normImg(it.thumbnailUrl) : '',
                });
            }
            if (items.length < 30) break;
            await sleep(150);
        }
    }
    console.log(`📝 글 ${list.size}개 확인`);
    if (!list.size && previous?.posts?.length) {
        throw new Error('공개 글 목록이 비어 있어 기존 홈페이지 데이터를 보존합니다.');
    }

    // 3) 글 본문 (새 글만 또는 전체)
    const posts = [];
    let fetched = 0, reused = 0, failed = 0;
    for (const meta of list.values()) {
        const old = existing.get(meta.id);
        if (old && old.blocks) {
            posts.push({ ...old, ...meta, thumb: old.thumb || meta.thumb });
            reused++;
            continue;
        }
        try {
            const html = await get(`https://m.blog.naver.com/${BLOG_ID}/${meta.id}`);
            const { blocks, images } = parsePost(html);
            if (!blocks.length) throw new Error('공개 글 본문을 확인하지 못했습니다.');
            posts.push({ ...meta, thumb: images[0] || meta.thumb, blocks });
            fetched++;
            process.stdout.write(`\r   본문 받는 중… ${fetched}개 (${meta.date} ${meta.title.slice(0, 20)})          `);
            await sleep(200);
        } catch (e) {
            failed++;
            console.warn(`\n⚠️ 실패: ${meta.title} - ${e.message}`);
        }
    }
    console.log(`\n✅ 새로 받은 글 ${fetched}개 / 기존 글 재사용 ${reused}개 / 실패 ${failed}개`);
    if (failed) throw new Error('글을 가져오는 중 오류가 발생하여 기존 홈페이지 데이터를 보존합니다.');

    posts.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    if (previous && JSON.stringify([previous.categories, previous.posts]) === JSON.stringify([cats, posts])) {
        console.log('공개 게시글 변경 없음');
        return;
    }
    const data = {
        syncedAt: new Date().toISOString(),
        blogUrl: `https://blog.naver.com/${BLOG_ID}`,
        categories: cats,
        posts,
    };
    const header = `/* ⚠️ 이 파일은 tools/sync-blog.js 가 자동으로 만든 파일입니다. 직접 수정하지 마세요.\n` +
        ` *    블로그 글 업데이트: maum-school 폴더에서 "node tools/sync-blog.js" 실행\n` +
        ` *    마지막 동기화: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} */\n`;
    fs.writeFileSync(OUT_FILE, header + 'const BLOG_DATA = ' + JSON.stringify(data) + ';\n', 'utf8');
    console.log(`💾 저장 완료: ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1024).toFixed(0)} KB)`);
})().catch(e => { console.error('❌ 오류:', e.message); process.exit(1); });
