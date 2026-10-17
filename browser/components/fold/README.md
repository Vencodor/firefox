# Fold (사이트 사이드바 전사)

웹페이지의 사이드바를 Mono 사이드바로 접어 넣는다(Fold). 켜진 사이트에 접속하면 페이지가 그려지기 전에
사이트 사이드바를 숨기고, 주소 영역 아래 토글로 그 메뉴를 Mono 사이드바에 보여 준다.
기본으로 켜져 있으며(`browser.customUI.fold.enabled`), 페이지 설정 패널에서 사이트별로 끈다
(`browser.customUI.fold.disabledSites`, 규칙 id 목록).
사이트마다 다른 사이드바를 같은 Mono 디자인으로 조작하게 하는 것이 목적이다.
화면 쪽은 `browser/base/content/custom-ui/browser-custom-fold.js`에 있다.

## 구조

| 파일 | 프로세스 | 역할 |
| --- | --- | --- |
| `rules/<site>.sys.mjs` | 공통 | 사이트 규칙: 사이드바 위치, 숨길 요소, 항목을 읽는 방법 |
| `FoldRules.sys.mjs` | 공통 | 규칙 목록과 주소로 규칙 찾기, 사이트별 Fold 설정. 규칙 형식 설명 |
| `FoldTranscriber.sys.mjs` | 웹페이지 | 공통 전사 엔진: 규칙에 따라 페이지를 읽어 메뉴 모델을 만든다. 페이지는 바꾸지 않는다 |
| `actors/FoldChild.sys.mjs` | 웹페이지 | 문서 시작 시 사이드바 접기와 읽기 확인(실패 시 되돌림), 설정 변경 반영, 변화 감시, 원래 요소 대신 클릭 |
| `actors/FoldParent.sys.mjs` | 브라우저 | 페이지에서 바뀐 메뉴를 해당 창의 사이드바로 전달 |
| `Fold.sys.mjs` | 브라우저 | actor 등록과 사이드바가 쓰는 함수(activate, deactivate, run) |

웹페이지의 사이드바는 지우지 않고 스타일시트로 숨긴다. 사이트의 스크립트가 계속 동작하고,
메뉴 항목을 누르면 숨겨진 원래 요소를 클릭해 사이트가 직접 처리한다(SPA 화면 전환, 로그인 상태 등).
규칙의 `ready` 조건을 채우지 못하면 숨김을 풀어 페이지를 원래대로 두고, 메뉴에는 실패 문구만 보인다.

## 사이트 추가

1. `rules/<site>.sys.mjs`에 규칙을 쓴다. 형식은 `FoldRules.sys.mjs`의 설명과 `rules/reddit.sys.mjs`를 따른다.
   - 난독화된 class 이름 대신 주소(`href`), ARIA 속성, 태그 구조처럼 오래 유지되는 단서를 쓴다.
   - shadow DOM 안도 찾으므로 경로를 따로 적지 않아도 된다.
2. `FoldRules.sys.mjs`의 `RULES`에 추가한다.
3. `moz.build`의 `EXTRA_JS_MODULES.fold.rules`에 파일을 추가한다.
4. 새 Mono 아이콘이 필요하면 `browser/base/content/custom-ui/resources/fold/`에 SVG를 넣고
   `browser/base/jar.mn`과 `browser-custom-fold.js`의 `iconNames`에 등록한다.

`moz.build`를 바꿨으므로 `./mach build`로 빌드한다. 이후 규칙만 고칠 때는 `./mach build faster`로 충분하다.

## 항목 종류

모델의 항목 종류(`kind`)는 `nav`, `entity`, `action`, `link`다(`ITEM_KINDS`).
텍스트 입력 같은 새 종류는 전사 엔진에서 읽는 방법과 사이드바의 행 그리기를 함께 추가한다.
