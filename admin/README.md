# 마음더하기학교 관리자 페이지

교직원이 학부모·학생·교사 게시판에 공지를 작성하거나 월간 학사일정을 발행합니다. 발행하면 GitHub의 `main`에 있는 `school-content.json`만 갱신되고 기존 Pages 워크플로가 배포합니다. 발행 화면에서 배포된 파일에 변경 내용이 도착했는지 확인합니다.

## 운영 설정

1. Cloudflare Workers에 이 디렉터리의 설정으로 배포합니다. 기본 `workers.dev` 주소를 사용하면 학교 홈페이지의 DNS를 변경하지 않아도 됩니다.
   ```sh
   npx wrangler deploy --config admin/wrangler.jsonc
   ```
2. Cloudflare Access에서 해당 Worker 주소 전체를 보호하고 로그인 방식으로 이메일 일회용 코드를 사용합니다. 허용 정책에는 지정된 교직원 이메일만 추가합니다. Worker에서도 Access JWT 서명과 계정, 애플리케이션, 이메일을 확인합니다.
3. 학교 계정에서 비공개 GitHub App을 등록합니다. 리포지토리 권한 `Contents: Read and write`만 부여하고 `maum-school/maum-school` 저장소에만 설치합니다. 웹훅은 필요하지 않습니다.
4. Worker의 설정에 아래 값을 등록합니다.

| 이름 | 값 |
| --- | --- |
| `ACCESS_TEAM_URL` | Cloudflare Access 팀 주소. 예를 들어 `https://school.cloudflareaccess.com` |
| `ACCESS_AUDIENCE` | 관리자 페이지를 보호하는 Access 애플리케이션의 AUD 값 |
| `ADMIN_EMAILS` | 허용한 교직원 이메일 목록. 쉼표로 구분 |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_INSTALLATION_ID` | 학교 저장소에 설치한 App의 설치 ID |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App의 PEM 파일 전체를 Worker 비밀 변수로 등록 |

PEM, 로그인 코드, 토큰은 공개 저장소에 올리지 않습니다. 발행한 본문은 공개 저장소의 변경 이력에 남으므로 공개용 공지와 일정만 발행합니다. 예전 관리자 화면에서 브라우저에 저장한 글은 원래 기기에서 확인해 옮깁니다.

## 확인

```sh
node --test admin/worker.test.mjs
```

운영 연결 후 교직원 로그인, 권한 없는 접근 차단, 학교가 승인한 공개 공지의 발행 및 홈페이지 상세 보기, 수정과 배포를 확인합니다.
