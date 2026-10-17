---
name: fold-site
description: Mono 브라우저의 Fold에 사이트를 등록하거나 깨진 Fold 규칙을 고친다. 사용자가 "Mono Fold capture"로 시작하는 캡처를 붙여 넣거나, Fold 사이트 추가·수정을 요청할 때 사용한다.
---

# Fold 사이트 등록

Fold는 웹사이트의 사이드바를 숨기고 그 메뉴를 Mono 사이드바에 Mono 디자인으로 다시 그린다.
사이트마다 JSON 규칙 하나가 "어디가 사이드바이고 무엇을 읽을지"를 정한다. 구조 설명은
`browser/components/fold/README.md`에 있다.

## 입력: Capture Fold

사용자는 등록할 사이트를 연 상태에서 좌상단 로고 메뉴 > More Tools > Capture Fold를 누른다.
그러면 "Mono Fold capture: <주소>"로 시작하는 텍스트가 클립보드에 복사되고, 사용자는 그것을 붙여 넣는다.
JSON 형식은 `browser/components/fold/FoldCapture.sys.mjs` 첫 주석에 설명되어 있다. 주로 볼 부분:

- `rule`: 이 주소에 이미 규칙이 있으면 그 id와 지금 읽히는 항목(`read`). `read`가 null이거나 항목이 적으면 규칙 수정 작업이다.
- `candidates`: 내비게이션으로 보이는 영역(점수 순). `path`는 `<body>`부터의 경로이고 `>>>`는 shadow DOM 안으로 들어가는 지점이다.
- `containers[]`: 가장 그럴듯한 영역을 감싸는 가장 바깥 세로 열.
  - `tree`: 그 안의 DOM. 텍스트, 링크, 버튼이 없는 요소는 빠져 있다. `shown: false`는 접혀 있거나 보이지 않는 요소다.
  - `ancestors`: 위쪽 요소.
  - `layout`: 위쪽 요소의 display와 grid 열.
  - `siblings`: 옆 요소와 위치.
- `main`: 본문 영역의 위치.

캡처는 사용자 화면 그대로라서 로그인 상태, 창 너비, 사이트의 A/B 실험에 따라 달라진다.
판단이 어려우면 다른 상태(로그아웃, 넓은 창)에서 한 번 더 캡처해 달라고 요청한다.

## 순서

1. **캡처 읽기:** 사이드바 영역을 고른다. 다음을 구분한다.
   - 상단 고정 링크(홈, 인기 등)
   - 반복되는 묶음(제목 + 항목 목록, 대개 `details/summary`나 제목 요소)
   - 행마다 붙은 보조 버튼(즐겨찾기 별 등)
2. **규칙 작성:** `browser/components/fold/rules/<id>.json`을 쓴다.
   - 형식은 `browser/components/fold/FoldRules.sys.mjs` 첫 주석을 따른다.
   - 예시는 `rules/reddit.json`이다.
   - id는 소문자와 `-`만 쓰고, 파일 이름과 같게 한다.
3. **등록:** `rules/index.json` 목록에 id를 추가한다. `rules/`의 JSON은 `moz.build` 와일드카드로 자동 포함되므로 다른 등록은 필요 없다.
4. **테스트 자료:** 캡처를 `browser/components/fold/tests/unit/captures/<id>.json`으로 저장한다.
   - 상태가 여러 개면 `<id>-<상태>.json`으로 저장한다.
   - **개인 정보를 익명화한다.** 사용자 이름, 구독·가입 목록의 고유 이름은 일반적인 이름으로 바꾸고, 사용자 사진 주소는 지운다. 구조와 개수는 유지한다.
   - `expect`를 추가한다: `{ "minItems": 읽혀야 할 최소 항목 수, "sections": [묶음 제목], "current": 현재 항목 이름 }`.
5. **검사:**
   - Firefox를 빌드할 수 있는 환경: `./mach test browser/components/fold/tests/unit`
   - 빌드할 수 없는 환경(클라우드 등): `node mono/skills/fold-site/scripts/check.mjs browser/components/fold/rules/<id>.json browser/components/fold/tests/unit/captures/<id>.json`
     - Playwright와 Chromium이 필요하다. 없으면 빌드 환경의 테스트를 사용자에게 부탁한다.
     - 결과에 읽힌 메뉴가 출력되므로, 원래 사이드바와 같은 구성인지 확인한다.
     - 이 검사는 Gecko 전용 확인(주소 패턴)을 건너뛴다. 최종 확인은 xpcshell 테스트다.
6. **아이콘(필요할 때만):** 의미가 분명한 항목에 맞는 Mono 아이콘이 없으면 다음을 함께 바꾼다.
   - `browser/base/content/custom-ui/resources/fold/<이름>.svg` 추가
   - `browser/base/jar.mn` 등록
   - `FoldRules.sys.mjs`의 `ICON_NAMES` 추가
   - 이 경우 jar.mn이 바뀌므로 사용자는 `./mach build`가 필요하다.
7. **보고:** 다음을 짧게 알린다.
   - 바뀐 파일, 검사 결과, 판단이 필요한 부분
   - 사용자가 확인할 것: `./mach build faster` 후 사이트를 열어 사이드바가 숨는지, 토글로 메뉴가 같은 구성으로 보이는지, 현재 항목이 표시되는지, `./mach run` 터미널에 `Fold:` 경고가 없는지

## 규칙을 쓰는 기준

- **오래 가는 단서를 쓴다:** 주소(`href`), id, 사이트 고유의 사용자 정의 태그 이름, `role`과 `aria-*`, 태그 구조를 쓴다. 빌드할 때마다 바뀌는 난독화된 class(`x1a2b3c` 같은 무작위 문자열)는 쓰지 않는다.
- **root:** 링크를 직접 담은 요소부터 바깥 container까지 몇 개를 우선순위대로 적는다. 사이트가 하나를 바꿔도 다른 것이 잡히게 한다.
- **선택자 범위:** 선택자는 그 요소가 속한 트리(문서 또는 하나의 shadow root) 안에서만 맞춰진다. `>>>` 경계를 넘는 조합자(예: 호스트 바깥 요소 `>` shadow 안 요소)는 동작하지 않는다.
- **hide:** 페이지 스타일시트로 숨기므로 문서 쪽(`>>>` 앞) 요소만 숨길 수 있다.
  - 보통 `containers[].path`에서 `>>>` 앞의 가장 바깥 요소를 숨긴다.
  - 사이드바를 다시 여는 햄버거 버튼도 함께 숨긴다.
  - 본문이나 헤더 전체를 숨기지 않는다.
  - 사이드바가 shadow DOM 안에만 있고 그것만 감싼 문서 쪽 요소가 없으면(예: 앱 전체가 하나의 호스트 안), 지금 엔진으로는 숨길 수 없다. 호스트를 숨기면 페이지 전체가 사라지므로 규칙을 만들지 말고, shadow root 안에 숨김 스타일을 넣는 엔진 확장이 필요하다고 보고한다.
- **css:** `layout`에서 grid 열이나 여백이 사이드바 자리를 남기면(예: `columns: "272px 992px"`), 본문이 그 자리를 쓰게 고친다.
  - `:has(> 숨긴 요소)`로 범위를 좁힌다.
  - `!important`를 붙인다.
  - 줄 목록으로 쓴다.
- **ready:**
  - `minItems`는 로그아웃 상태에서도 채워질 만큼 작게 잡는다(보통 3).
  - `timeoutMs`는 3000에서 5000 사이로 한다.
  - 못 읽으면 원래 사이드바가 그대로 보이므로 안전하다.
- **current:** 사이트가 페이지 안 이동 뒤 `aria-current`를 늦게 바꾸거나 쓰지 않으면 `"url"`로 둔다.
- **main / groups:** 상단 고정 링크는 `main`에 경로와 아이콘으로 적고, 반복 묶음은 `groups`로 읽는다.
  - 항목 종류(`kind`) 기준: 커뮤니티·채널처럼 사진이나 첫 글자가 어울리는 개체는 `entity`, 만들기·관리 같은 동작은 `action`, 다른 사이트로 나가는 링크는 `link`, 나머지는 `nav`.
- **description:** 사이트 구조와 판단 근거를 적어, 다음에 고칠 사람이 캡처 없이도 이해하게 한다.
- **하지 않는 것:**
  - 규칙에 없는 키를 만들지 않는다(검사에서 실패한다).
  - 규칙에 실행 코드를 넣지 않는다.
  - 사이트 로고, 광고, 저작권 문구는 메뉴로 가져오지 않는다.

## 규칙 수정

캡처의 `rule.read`가 null이면 root 선택자가 더 이상 맞지 않는 것이다. 항목 수가 줄었다면 묶음이나 항목 선택자를 확인한다.
id와 파일은 유지하고, 바뀐 구조에 맞게 선택자를 고친다. 그다음 새 캡처를 익명화해서 테스트 자료를 바꾸거나, 상태가 다르면 별도 파일로 추가한다.
