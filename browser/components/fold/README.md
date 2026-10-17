# Fold (사이트 사이드바 전사)

웹페이지의 사이드바를 Mono 사이드바로 접어 넣는다(Fold). 켜진 사이트에 접속하면 페이지가 그려지기 전에
사이트 사이드바를 숨기고, 주소 영역 아래 토글로 그 메뉴를 Mono 사이드바에 보여 준다.
기본으로 켜져 있으며(`browser.customUI.fold.enabled`), 페이지 설정 패널에서 사이트별로 끈다
(`browser.customUI.fold.disabledSites`, 규칙 id 목록). 메뉴를 받을 Mono UI(`browser.customUI.enabled`)와
세로 탭(`sidebar.verticalTabs`)이 꺼져 있으면 사이트 사이드바를 숨기지 않는다.
사이트마다 다른 사이드바를 같은 Mono 디자인으로 조작하게 하는 것이 목적이며, 사이드바의 모든 기능을
옮기는 것을 원칙으로 한다: 링크, 아이콘만 있는 버튼, 행의 메뉴 버튼과 즐겨찾기, 검색창, 체크박스·스위치.
화면 쪽은 `browser/base/content/custom-ui/browser-custom-fold.js`에 있다.

## 구조

| 파일 | 프로세스 | 역할 |
| --- | --- | --- |
| `rules/<site>.json`, `rules/index.json` | 공통 | 사이트 규칙(데이터만): 사이드바 위치, 숨길 요소, 항목을 읽는 방법. `index.json`은 사용하는 규칙 id 목록 |
| `FoldRules.sys.mjs` | 공통 | 규칙 형식 설명과 검사(`validateRule`), 규칙 읽기와 공유, 주소로 규칙 찾기, 사이트별 Fold 설정 |
| `FoldTranscriber.sys.mjs` | 웹페이지 | 공통 전사 엔진: 규칙에 따라 페이지를 읽어 메뉴 모델을 만든다. 페이지는 바꾸지 않는다 |
| `FoldCapture.sys.mjs` | 공통 | Capture Fold: 페이지의 내비게이션을 규칙 작성용 데이터로 기록, 그 데이터를 문서로 다시 만들어 규칙 검사(`checkCapture`) |
| `actors/FoldChild.sys.mjs` | 웹페이지 | 문서 시작 시 사이드바 접기와 읽기 확인(실패 시 되돌림), 설정 변경과 브라우저의 동기화 반영, 변화 감시, 원래 요소 대신 클릭·입력, 사이트 메뉴 중계 |
| `actors/FoldParent.sys.mjs` | 브라우저 | 페이지에서 바뀐 메뉴를 검사해 해당 창의 사이드바로 전달 |
| `actors/FoldCapture*.sys.mjs` | 양쪽 | Capture Fold 요청 시에만 등록되는 actor |
| `Fold.sys.mjs` | 브라우저 | actor 등록과 사이드바가 쓰는 함수(activate, deactivate, sync, run, input, openPopup, capture), 페이지에서 온 모델 검사 |
| `tests/unit/` | 테스트 | 규칙 검사와, `captures/`의 캡처로 각 규칙이 모든 조작 요소를 읽는지 확인하는 xpcshell 테스트 |
| `tests/browser/` | 테스트 | 테스트 사이트로 실제 숨김(메뉴가 닫혀 있을 때, 새로고침, 사이트별 끄기)과 메뉴 조작을 확인하는 mochitest |

규칙 JSON은 브라우저 프로세스가 읽어 검사한 뒤 공유 데이터(`sharedData`)로 웹페이지 프로세스에 넘긴다.
웹페이지 프로세스는 파일을 직접 읽지 않는다. 검사에 실패한 규칙은 오류를 남기고 쓰지 않는다.

웹페이지의 사이드바는 지우지 않고 사용자 스타일시트로 감춘다. 사용자 스타일시트는 shadow DOM 안에도 적용되고
페이지 스타일보다 우선한다. 감춘 사이드바는 화면 흐름에서 빠지고 보이지도 클릭되지도 않지만 계속 렌더링되므로,
화면에 보일 때만 내용을 불러오는 사이트도 메뉴가 채워진다. 사이트의 스크립트가 계속 동작하고, 메뉴 항목을 누르면
감춘 원래 요소를 클릭하거나 입력해 사이트가 직접 처리한다(SPA 화면 전환, 로그인 상태 등).
페이지는 문서가 시작될 때 스스로 사이드바를 감추고, 브라우저도 Fold 사이트의 탭이 로드되거나 선택될 때와
설정이 바뀔 때 동기화를 보낸다(`Fold.sync`). 그래서 Fold가 준비되기 전에 열린 탭도 메뉴를 열지 않은 채 감춰진다.
규칙의 `ready` 조건을 채우지 못하면 숨김을 풀어 페이지를 원래대로 두고, 메뉴에는 실패 문구만 보인다.
페이지 쪽 판단은 `browser.customUI.fold.loglevel`을 `Debug`로 바꾸면 브라우저 콘솔에서 볼 수 있다.

## 사이트 추가

AI에게 맡기는 절차는 `mono/skills/fold-site/SKILL.md`에 있다. 요약:

1. 사이트를 열고 좌상단 로고 메뉴 > More Tools > Capture Fold를 누른다. 내비게이션 정보가 클립보드에 복사된다.
2. AI가 `rules/<id>.json`을 쓰고 `rules/index.json`에 id를 추가한다. 형식은 `FoldRules.sys.mjs` 첫 주석과 `rules/reddit.json`을 따른다.
3. 익명화한 캡처를 `tests/unit/captures/<id>.json`에 두고 `./mach test browser/components/fold/tests/unit`로 확인한다.
4. 아이콘은 사이트의 SVG 아이콘을 Mono 글자색으로 쓰고, 맞지 않으면 규칙의 `customIcons`로 바꾼다. 여러 사이트가
   함께 쓸 Mono 아이콘만 `resources/fold/`, `browser/base/jar.mn`, `FoldRules.sys.mjs`의 `ICON_NAMES`에 등록한다.

`rules/`의 JSON은 `moz.build` 와일드카드로 포함되므로 규칙만 추가·수정할 때는 `./mach build faster`로 충분하다.

## 항목 종류

모델의 항목 종류(`kind`)는 `nav`, `entity`, `action`, `link`, `field`(텍스트 입력), `toggle`(체크박스·스위치)이다
(`FoldRules.sys.mjs`의 `ITEM_KINDS`). 항목은 행의 다른 조작을 `actions`로 가진다. 새 종류는 전사 엔진에서 읽는 방법,
브라우저의 모델 검사(`cleanModel`), 사이드바의 행 그리기를 함께 추가한다.
