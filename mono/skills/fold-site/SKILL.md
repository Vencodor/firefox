---
name: fold-site
description: Mono 브라우저의 Fold에 사이트를 등록하거나 깨진 Fold 규칙을 고친다. 사용자가 "Mono Fold capture"로 시작하는 캡처를 붙여 넣거나, Fold 사이트 추가·수정을 요청할 때 사용한다.
---

# Fold 사이트 등록

Fold는 웹사이트의 사이드바를 숨기고 그 메뉴를 Mono 사이드바에 Mono 디자인으로 다시 그린다.
사이트마다 JSON 규칙 하나가 "어디가 사이드바이고 무엇을 읽을지"를 정한다. 구조 설명은
`browser/components/fold/README.md`에 있다.

**원칙: 사이트 사이드바의 모든 기능을 옮긴다.** 링크뿐 아니라 아이콘만 있는 버튼, 행마다 붙은 메뉴 버튼과
즐겨찾기, 검색창, 체크박스·스위치까지 읽는다. 옮기지 않을 요소(사이트 사이드바 자체를 접는 버튼처럼 Fold에서
의미가 없는 것)는 `exclude`에 적고 `description`에 이유를 쓴다. 읽지도 제외하지도 않은 조작 요소가 있으면
검사가 실패한다.

## 입력: Capture Fold

사용자는 등록할 사이트를 연 상태에서 좌상단 로고 메뉴 > More Tools > Capture Fold를 누른다.
그러면 "Mono Fold capture: <주소>"로 시작하는 텍스트가 클립보드에 복사되고, 사용자는 그것을 붙여 넣는다.
JSON 형식은 `browser/components/fold/FoldCapture.sys.mjs` 첫 주석에 설명되어 있다. 주로 볼 부분:

- `rule`: 이 주소에 이미 규칙이 있으면 규칙 수정 작업이다.
  - `read`: 지금 읽히는 항목 수와 묶음, 놓친 조작 요소(`missed`). null이면 root가 더 이상 맞지 않는다.
  - `folded`: 실제 페이지에 숨김을 적용한 상태의 측정. 본문 위치(`main`)와 hide·remove 선택자마다 찾은 수(`found`)와 아직 그려지는 수(`drawn`). 캡처 쪽 `main`(숨기기 전)과 비교해 본문이 사이드바 자리를 차지했는지, 숨김이 실제로 적용됐는지 확인한다.
- `candidates`: 내비게이션으로 보이는 영역(점수 순). `path`는 `<body>`부터의 경로이고 `>>>`는 shadow DOM 안으로 들어가는 지점이다.
- `containers[]`: 가장 그럴듯한 영역을 감싸는 가장 바깥 세로 열.
  - `tree`: 그 안의 DOM. 텍스트, 링크, 버튼이 없는 요소는 빠져 있다. `shown: false`는 접혀 있거나 보이지 않는 요소다. SVG 아이콘은 모양만 남긴 `icon` 문자열로 들어 있다.
  - `ancestors`: 위쪽 요소.
  - `layout`: 위쪽 요소의 display와 grid 열.
  - `siblings`: 옆 요소와 위치.
- `main`: 본문 영역의 위치.
- `overlays`: 캡처할 때 사이드바 밖에 열려 있던 사이트 메뉴·대화상자의 DOM. 행 메뉴("...")나 대화상자 규칙을 확인하려면 사용자에게 그 메뉴를 연 채로 Capture Fold를 눌러 달라고 한다.

캡처는 사용자 화면 그대로라서 로그인 상태, 창 너비, 사이트의 A/B 실험에 따라 달라진다.
판단이 어려우면 다른 상태(로그아웃, 넓은 창)에서 한 번 더 캡처해 달라고 요청한다.

## 순서

1. **캡처 읽기:** 사이드바 영역을 고른다. 다음을 구분한다.
   - 상단 고정 링크(홈, 인기 등) → `main`
   - 사이드바 어디에나 있는 검색창, 새로 만들기 같은 단독 조작 → `extras`
   - 반복되는 묶음(제목 + 항목 목록, 대개 `details/summary`나 제목 버튼) → `groups`
   - 행마다 붙은 버튼(즐겨찾기 별, 메뉴 버튼) → `groups.container`로 행을 지정하면 그 행의 액션이 된다
2. **규칙 작성:** `browser/components/fold/rules/<id>.json`을 쓴다.
   - 형식은 `browser/components/fold/FoldRules.sys.mjs` 첫 주석을 따른다.
   - 예시는 `rules/reddit.json`이다.
   - id는 소문자와 `-`만 쓰고, 파일 이름과 같게 한다.
3. **등록:** `rules/index.json` 목록에 id를 추가한다. `rules/`의 JSON은 `moz.build` 와일드카드로 자동 포함되므로 다른 등록은 필요 없다.
4. **테스트 자료:** 캡처를 `browser/components/fold/tests/unit/captures/<id>.json`으로 저장한다.
   - 상태가 여러 개면 `<id>-<상태>.json`으로 저장한다.
   - **개인 정보를 익명화한다.** 사용자 이름, 구독·가입 목록의 고유 이름은 일반적인 이름으로 바꾸고, 사용자 사진 주소는 지운다. 구조와 개수는 유지한다.
   - `expect`를 추가한다: `{ "minItems": 읽혀야 할 최소 항목 수, "sections": [묶음 제목], "labels": [반드시 읽혀야 할 항목·액션 이름], "current": 현재 항목 이름 }`.
5. **검사:**
   - Firefox를 빌드할 수 있는 환경: `./mach test browser/components/fold/tests/unit`
   - 빌드할 수 없는 환경(클라우드 등): `node mono/skills/fold-site/scripts/check.mjs browser/components/fold/rules/<id>.json browser/components/fold/tests/unit/captures/<id>.json`
     - Playwright와 Chromium이 필요하다. 없으면 빌드 환경의 테스트를 사용자에게 부탁한다.
     - 결과에 읽힌 메뉴(항목 종류, 현재 항목, 액션, 아이콘 종류, 접힘 상태)가 출력되므로, 원래 사이드바와 같은 구성인지 확인한다.
     - 이 검사는 Gecko 전용 확인(주소 패턴)을 건너뛴다. 최종 확인은 xpcshell 테스트다.
   - 레이아웃과 실제 숨김은 캡처 구조만으로 확인할 수 없다. 사용자에게 규칙을 적용한 빌드에서 Capture Fold를 다시 눌러 달라고 해서 `rule.folded`를 확인한다. 저장된 HTML 페이지가 있으면 `check.mjs --capture <page.html> <url> <rule.json>`으로도 측정할 수 있다.
6. **아이콘:** 이름 붙은 아이콘이 없는 항목과 액션은 사이트의 SVG 아이콘을 Mono 글자색으로 그린다(`siteIcons: false`로 끈다).
   - 사이트 아이콘이 없거나(아이콘 글꼴 등) 의미에 맞지 않으면 규칙의 `customIcons`에 모양만 있는 SVG를 넣고 그 이름을 쓴다. 빌드 설정을 바꿀 필요가 없다.
   - 여러 사이트에서 함께 쓸 Mono 아이콘이 필요할 때만 `resources/fold/<이름>.svg`, `browser/base/jar.mn`, `FoldRules.sys.mjs`의 `ICON_NAMES`를 함께 바꾼다. 이 경우 사용자는 `./mach build`가 필요하다.
7. **보고:** 다음을 짧게 알린다.
   - 바뀐 파일, 검사 결과, 판단이 필요한 부분
   - 사용자가 확인할 것: `./mach build faster` 후 사이트를 열어 사이드바가 숨는지, 토글로 메뉴가 같은 구성으로 보이는지, 현재 항목이 표시되는지, `./mach run` 터미널에 `Fold` 경고가 없는지
   - 문제가 있으면 `about:config`에서 `browser.customUI.fold.loglevel`을 `Debug`로 바꾸면 페이지 쪽 판단(규칙, 숨김, 동기화)이 브라우저 콘솔에 나온다.

## 규칙을 쓰는 기준

- **오래 가는 단서를 쓴다:** 주소(`href`), id, 사이트 고유의 사용자 정의 태그 이름, `role`과 `aria-*`, 태그 구조를 쓴다. 빌드할 때마다 바뀌는 난독화된 class(`x1a2b3c` 같은 무작위 문자열)는 쓰지 않는다.
- **root:** 링크를 직접 담은 요소부터 바깥 container까지 몇 개를 우선순위대로 적는다. 사이트가 하나를 바꿔도 다른 것이 잡히게 한다.
- **선택자 범위:** 선택자는 그 요소가 속한 트리(문서 또는 하나의 shadow root) 안에서만 맞춰진다. `>>>` 경계를 넘는 조합자(예: 호스트 바깥 요소 `>` shadow 안 요소)는 동작하지 않는다.
- **hide:** 사이드바를 감추는 선택자. 사용자 스타일시트로 적용되므로 shadow DOM 안의 요소도 숨길 수 있다(선택자는 그 요소의 트리 안에서 쓴다).
  - 감춘 요소는 화면 흐름에서 빠지고 보이지도 클릭되지도 않지만, 계속 렌더링되므로 사이트가 화면에 보일 때만 불러오는 내용도 채워진다.
  - 보통 `containers[].path`의 가장 바깥 세로 열을 감춘다. 앱 전체를 감싼 호스트처럼 본문까지 담은 요소는 감추지 않는다.
- **remove:** 화면에서 완전히 빼는 선택자(display: none). 사이드바를 다시 여는 햄버거 버튼처럼 Fold에서 쓸모없는 페이지 쪽 조작에 쓴다. 본문이나 헤더 전체는 빼지 않는다.
- **css:** `layout`에서 grid 열이나 여백이 사이드바 자리를 남기면(예: `columns: "272px 992px"`), 본문이 그 자리를 쓰게 고친다.
  - `:has(> 숨긴 요소)`로 범위를 좁힌다.
  - `!important`를 붙인다.
  - 줄 목록으로 쓴다.
- **ready:**
  - `minItems`는 로그아웃 상태에서도 채워질 만큼 작게 잡는다(보통 3).
  - `timeoutMs`는 3000에서 5000 사이로 한다.
  - 못 읽으면 원래 사이드바가 그대로 보이므로 안전하다.
- **current:** 기본값 `"auto"`는 항목이나 행의 `aria-current`·`aria-selected`·`currentSelector`를 먼저 보고, 없으면 주소로 판단한다.
  - 사이트가 표시를 늦게 바꾸거나 쓰지 않으면 `"url"`(주소만).
  - 주소는 그대로인데 화면만 바뀌는 SPA는 `"marker"`(표시만)와, 선택된 행을 나타내는 사이트의 선택자 `currentSelector`(예: `".selected"`).
- **main / groups / extras:** 상단 고정 링크는 `main`에 경로와 아이콘으로, 반복 묶음은 `groups`로, 묶음 밖의 단독 조작(검색창, 새로 만들기)은 `extras`로 읽는다.
  - `groups.heading`은 제목 글자를 가리킨다. 제목을 감싼 버튼이나 `summary`는 자동으로 접기 버튼이 되고 항목에서 빠지므로, 제목 버튼을 따로 피하는 선택자를 만들지 않는다. 그 버튼에 `aria-expanded`가 있으면 묶음을 접고 펼 수 있다.
  - `groups.items`에 버튼과 입력 요소까지 넣는다. 글자 없는 버튼은 접근성 이름(`aria-label`, `aria-labelledby`, `<label>`, `title`)으로 읽는다. 텍스트 입력은 `field`, 체크박스·스위치는 `toggle` 항목이 된다.
  - `groups.container`로 행을 지정하면 행의 첫 링크가 항목, 나머지 버튼이 액션이 된다. 켜짐 상태를 `aria-pressed`로 알리지 않는 토글은 `groups.pressed` 선택자로 알려 준다.
- **사이트 메뉴와 대화상자:** 버튼 자신이나 가까운 감싸는 요소(행 안, 세 단계까지)에 `aria-haspopup`이 있으면, 항목이든 액션이든 누를 때 사이트 메뉴를 열어 그 항목을 Mono 메뉴로 보여 준다. 메뉴 항목이나 버튼이 대화상자(`role="dialog"`, `alertdialog`, `<dialog>`)를 열면 그 제목, 설명, 입력창, 체크박스, 버튼을 사이드바의 Mono 시트로 보여 준다. 사이트의 메뉴·대화상자와 뒤를 어둡게 하는 배경은 감춘다.
  - `aria-haspopup`이 없는 메뉴 버튼은 규칙의 `popups` 선택자로 지정한다(예: Gemini의 노트북 메뉴).
  - 메뉴 항목이 다시 하위 메뉴를 여는 경우는 아직 지원하지 않는다. 그런 항목이 있으면 보고한다.
  - 항목 종류(`kind`) 기준: 커뮤니티·채널처럼 사진이나 첫 글자가 어울리는 개체는 `entity`, 만들기·관리 같은 동작은 `action`, 다른 사이트로 나가는 링크는 `link`, 나머지는 `nav`. `field`와 `toggle`은 요소 종류로 정해진다.
- **description:** 사이트 구조와 판단 근거를 적어, 다음에 고칠 사람이 캡처 없이도 이해하게 한다.
- **하지 않는 것:**
  - 규칙에 없는 키를 만들지 않는다(검사에서 실패한다).
  - 규칙에 실행 코드를 넣지 않는다.
  - 사이트 로고, 광고, 저작권 문구는 메뉴로 가져오지 않는다.

## 규칙 수정

캡처의 `rule.read`가 null이면 root 선택자가 더 이상 맞지 않는 것이다. 항목 수가 줄었거나 `missed`가 있으면 묶음이나 항목 선택자를 확인한다.
`rule.folded`에서 `drawn`이 0이 아니면 숨김 선택자가 그 요소를 감추지 못한 것이고, `main`이 숨기기 전과 같은 자리면 `css`가 본문에 사이드바 자리를 주지 못한 것이다.
id와 파일은 유지하고, 바뀐 구조에 맞게 선택자를 고친다. 그다음 새 캡처를 익명화해서 테스트 자료를 바꾸거나, 상태가 다르면 별도 파일로 추가한다.
