# Mono UI Style

Mono 브라우저의 현재 디자인 기준이다. 사용자 결정과 실제 사용자 지정 UI 소스를 기준으로 작성했다.
새 화면과 기존 Firefox 화면의 외형을 이전할 때 이 문서를 먼저 읽는다.

- 최신 사용자 지시를 이 문서보다 우선한다.
- 제품의 시각 기준은 아래의 Mono 색상·형태·자산이다. Firefox의 보라색·주황색 강조나 메뉴 그라데이션을 기본값으로 가져오지 않는다.
- Firefox의 컴포넌트·명령·접근성 구현은 재사용하고, 외형은 Mono 토큰에 연결한다.
- 실제 색상 값은 `browser/base/content/custom-ui/design-tokens.css`에서 관리한다. 문서만 수정하면 화면이 바뀌는 구조는 아니다.

## 1. 기본 방향

- 세로 탭과 현재 페이지를 중심으로 구성한다. 조작 요소와 장식은 필요한 만큼만 배치한다.
- 흰색·회색·검정 계열의 중성 표면, 얇은 경계선, 약한 그림자를 사용한다.
- 선택·호버 상태는 표면의 밝기와 경계선으로 구분한다. 강한 유채색을 일반 강조색으로 추가하지 않는다.
- 페이지·메뉴·설정 카드는 같은 모서리 체계를 사용한다.
- 밝은 테마와 어두운 테마는 같은 구조를 유지한다. 상태 색상과 키보드 포커스 표시를 보존한다.
- 사이드바 하단의 **개인·에이전트·설정 버튼은 제거된 상태**다. 초기 배치안에 있다는 이유로 다시 추가하지 않는다.

## 2. 참조 색상

### 공통 팔레트

아래 값은 `light-dark(밝은 테마, 어두운 테마)` 순서다.

| 용도 | CSS 토큰 | 밝은 테마 | 어두운 테마 |
| --- | --- | --- | --- |
| 창·사이드바 배경 | `--custom-background` | `#ECEEF1` | `#191B20` |
| 카드·메뉴 표면 | `--custom-surface` | `#FFFFFF` | `#25282F` |
| 보조 표면·주소창 | `--custom-surface-subtle` | `#FCFCFD` | `#22252B` |
| 호버 표면 | `--custom-hover` | `#F4F5F7` | `#30343D` |
| 기본 글자·아이콘 | `--custom-ink` | `#1B1D21` | `#ECEEF2` |
| 보조 글자·아이콘 | `--custom-muted` | `#5A5F67` | `#ACB3BF` |
| 기본 경계선 | `--custom-line` | `#E2E5E9` | `#3B404A` |
| 강조 경계선 | `--custom-line-strong` | `#D9DDE3` | `#4A515E` |
| 일반 강조 | `--custom-accent` | `#34383F` | `#D3D7DF` |
| 강조된 항목의 약한 표면 | `--custom-accent-subtle` | `#E4E7EB` | `#393E47` |
| 일반 강조 표면 위 글자 | `--custom-accent-ink` | `#FFFFFF` | `#1B1D21` |

고정 탭 배경은 `--custom-pin-background`를 사용한다. 기본 글자색을 5% 섞은 투명 배경이다.

### 검정으로 고정한 메뉴 요소

이 규칙은 밝은·어두운 테마 모두에 적용한다. 구현 위치는 `browser-custom-popups.css`다.

| 요소 | 배경·선 | 글자 | 상태 |
| --- | --- | --- | --- |
| 앱 메뉴의 일반형 `Sign in` | `#000000` | `#FFFFFF` | 기본·호버·누름 모두 단색 |
| 안내 카드형 `Sign in` 링크 | `#000000` | `#FFFFFF` | 검정 버튼 형태, 호버 시 밑줄 |
| 앱 메뉴 상단 계정 구분선 | `#000000` | 해당 없음 | `border-image: none`, 그라데이션 없음 |

일반형·카드형·로그아웃 후 로그인 버튼을 함께 다룬다. 한 가지 표시 형태만 바꾸고 나머지에 Firefox 강조색을 남기지 않는다.
안내 카드의 바탕은 `--custom-surface-subtle`, 본문은 `--custom-ink`를 사용한다.
순수 검정과 흰색의 코드 참조는 각각 `--color-black`, `--color-white`이며, 배경·글자·구분선용 의미 토큰에 연결한다.

### 상태를 전달하는 색상

| 용도 | CSS 토큰 | 밝은 테마 | 어두운 테마 |
| --- | --- | --- | --- |
| 주의가 필요한 에이전트 상태 | `--custom-attention` | `#B45309` | `#F59E0B` |
| 주의 상태의 글자 | `--custom-attention-ink` | `#92400E` | `#FBBF24` |

주의 색상은 상태 전달에 한정한다. 브랜드 강조색으로 확장하지 않는다.
보안·오류·차단·비활성 상태의 의미는 유지한다. 색상과 함께 아이콘·문구로도 상태를 구분한다.
에이전트 상태 표면은 구현 중이며, 이 토큰의 존재가 작업 실행 기능의 완성을 뜻하지 않는다.

고대비 모드에서는 `Canvas`, `CanvasText`, `ButtonFace`, `ButtonBorder`, `Highlight`, `HighlightText` 등 시스템 색상을 따른다.
이 모드에서는 위의 고정 색상보다 시스템의 대비 설정을 우선하고 그림자를 제거한다.

## 3. 로고와 브랜드 자산

### 경로

로컬 저장소 루트는 `C:/mozilla-source/firefox`다. 아래 소스 경로는 이 루트를 기준으로 한다.

```text
소스 폴더: browser/base/content/custom-ui/resources/mono/
정적 로고: browser/base/content/custom-ui/resources/mono/logo/
패키지 경로: chrome://browser/content/custom-ui/resources/mono/
```

| 파일 (`logo/` 아래) | 용도 |
| --- | --- |
| `logo-mark.svg` | 기본 심볼, 새 탭 중앙 |
| `logo-mark-small.svg` | 작은 심볼, 사이드바·설정 탐색 |
| `logo-outline.svg` | 밝은 표면용 외곽선 심볼 |
| `logo-outline-on-dark.svg` | 어두운 표면용 외곽선 심볼 |
| `logo-outline-small.svg` | 밝은 표면의 작은 외곽선 심볼 |
| `logo-outline-small-on-dark.svg` | 어두운 표면의 작은 외곽선 심볼 |
| `mono-lockup-vertical.svg` | 밝은 표면용 세로 조합 로고 |
| `mono-lockup-vertical-on-dark.svg` | 어두운 표면용 세로 조합 로고 |

실제 참조 주소 예:

```text
chrome://browser/content/custom-ui/resources/mono/logo/logo-mark-small.svg
chrome://browser/content/custom-ui/resources/mono/logo/logo-mark.svg
chrome://browser/content/custom-ui/resources/mono/logo/logo-outline-small-on-dark.svg
```

현재 사이드바 심볼은 **18×18px**, 새 탭 중앙 심볼은 **56×56px**다. 작은 창에서는 새 탭 로고 크기를 줄일 수 있다.
두 기본 심볼은 밝은·어두운 테마에서 같은 SVG를 사용한다. 설정 탐색의 심볼은 `--page-nav-heading-logo-size`로 크기를 정한다.

외곽선 심볼은 창의 테마 이름이 아니라 **실제로 놓이는 표면의 밝기**에 맞춰 선택한다.
현재 `--custom-logo-on-surface`와 `--custom-logo-on-ink`에 배경별 작은 외곽선 심볼이 정의되어 있다.

### 로고 고유 색상

| 부분 | 색상 코드 |
| --- | --- |
| 심볼 내부 그라데이션 | `#AEBFD6` → `#1D2740` |
| 기본 외곽선 | `#2B3240` |
| 어두운 배경용 외곽선 | `#E8EDF3` |
| 기본 세로 조합의 `MONO` 글자 | `#1F2633` |
| 어두운 배경용 조합의 `MONO` 글자 | `#F1F4F8` |

로고는 사용자 제공 원본을 사용한다. 메뉴에서 Firefox 그라데이션을 제거하는 작업을 로고 원본의 색상 변경으로 확대하지 않는다.
파일명·SVG 메타데이터·비율을 보존하고, 화면 크기에 맞는 작은 심볼과 배경별 변형을 선택한다.

정적 로고 8개와 애니메이션 SVG 7개는 `browser/base/jar.mn`에 등록되어 있다.
상세 자산 목록은 [Mono 브랜드 리소스](browser/base/content/custom-ui/resources/mono/README.md)를 참고한다.
애니메이션 파일의 존재와 실제 에이전트 기능 연결은 구분한다. 동작 줄이기 설정에서는 정적 표현을 제공한다.

## 4. 모서리·크기·간격

현재 구현의 시작값이다. 창 크기와 기존 브라우저의 크기 조절 상태를 존중하며, 모든 창에 고정 규격으로 강제하지 않는다.

| 항목 | 값 | 코드 참조 |
| --- | --- | --- |
| 페이지·메뉴·설정 카드 모서리 | 14px | `--border-radius-custom-page` |
| 탭·버튼·입력 요소 모서리 | 10px | `--border-radius-custom-tab` |
| 고정 탭 모서리 | 12px | `--border-radius-custom-pin` |
| 펼친 탭 사이드바 시작 폭 | 252px | `--sidebar-expanded-launcher-width` |
| 작은 창의 사이드바 시작 폭 | 200px | `max-width: 720px` 규칙 |
| 사이드바 헤더 높이 기준 | 44px | `--size-custom-header` |
| 일반 페이지 상단 탐색 높이 기준 | 52px | `--size-custom-navigation-header` |
| 일반 페이지 주소창 높이 | 36px | `--size-custom-address` |
| 탐색 조작 높이 기준 | 32px | `--size-custom-navigation-control` |
| 일반 탭 높이 기준 | 40px | `--size-custom-tab` |
| 기존 AI 상태 카드 폭 기준 | 340px | `--size-custom-card` |
| 영역 사이 간격 | 10px | `--space-custom-gap` |
| 가장자리 여백 | 6px | `--space-custom-edge` |
| 내부 여백 | 8px | `--space-custom-inset` |
| 기본 패딩 | 12px | `--space-custom-padding` |
| 섹션 간격 | 16px | `--space-custom-section` |
| 탭 그룹 간격 | 14px | `--space-custom-groups` |

검색 제안도 페이지와 같은 **14px** 외곽 모서리를 사용한다. 제안 행 자체에는 탭 모서리 토큰을 사용한다.
좁은 창에서는 페이지와 주요 조작 요소를 우선하고, 가로 넘침을 만들지 않도록 배치한다.

## 5. 글꼴과 글자 크기

| 용도 | 지정 |
| --- | --- |
| UI·설정 본문 | `"IBM Plex Sans KR", system-ui, sans-serif` (`--font-family-custom`) |
| Mono 이름·단축키·일부 상태 정보 | `"IBM Plex Mono", ui-monospace, monospace` |
| 기본 라벨 | 13px (`--font-size-custom-label`) |
| 작은 보조 문구 | 12px (`--font-size-custom-small`) |
| 단축키 | 11px (`--font-size-custom-shortcut`) |
| 카드 제목 | 14px (`--font-size-custom-title`) |

현재 위 글꼴 파일을 UI에 번들로 배포하는 `@font-face` 등록은 없다. 설치된 글꼴이 없으면 시스템 폴백을 사용한다.
세로 조합 SVG의 글꼴 지정은 원본 자산의 일부로 보존한다.

## 6. 그림자와 움직임

- 탭: `--box-shadow-custom-tab`.
- 페이지: `--box-shadow-custom-page`.
- 메뉴·떠 있는 카드: `--box-shadow-custom-float`.

그림자의 색상 기준은 밝은 테마에서 `rgb(27 29 33 / …)`, 어두운 테마에서 `rgb(0 0 0 / …)`다.
현재 탭은 밝은 테마 8%·6%, 페이지는 4%·6%, 떠 있는 표면은 5%·14%의 두 겹 그림자를 사용한다.
어두운 테마의 대응 값은 탭 20%·14%, 페이지 20%·15%, 떠 있는 표면 24%·32%다.
정확한 오프셋·흐림 값은 공통 토큰을 재사용한다. 유채색 광택이나 강한 그림자를 별도로 추가하지 않는다.

호버·선택 전환은 짧고 절제되게 사용한다. `prefers-reduced-motion`을 따르고, 큰 레이아웃 이동이나 장식을 위한 연속 애니메이션을 기본으로 추가하지 않는다.

## 7. 화면별 적용

- **사이드바:** 실제 세로 탭·고정 탭·그룹을 유지한다. 선택 표면과 약한 그림자로 현재 탭을 구분한다. 좌상단 Mono 아이콘은 기존 앱 메뉴를 연다.
- **주소창·새 탭:** 일반 페이지는 상단 탐색을 사용하고, 빈 새 탭에서는 가운데 검색 표면을 사용한다. 이 전환은 새 탭 상태에 한정한다.
- **메뉴·팝업:** 표면·간격·모서리를 통일한다. 로그인 표시 형태별로 검정 규칙을 적용하고, 권한·보안·오류 안내의 정보를 보존한다.
- **설정:** 설정 메뉴·명령은 탭·주소창·사이드바 없는 별도 창을 연다. Windows 기본 제목줄 대신 Mono 로고·제목과 창 제어 버튼이 있는 자체 헤더를 사용한다. 중성 배경, 구분되는 카드, 같은 검색·입력 요소 모서리를 사용하고 기존 검색·설정 저장·하위 대화상자 경로를 재사용한다. 이미 열린 설정 창은 복원하여 앞으로 가져온다.
- **에이전트:** 같은 Mono 표면·아이콘·상태 토큰을 사용한다. 준비 중인 UI를 실제 실행 기능이 연결된 것처럼 표시하지 않는다.

### 설정 창의 표시 범위

사용자가 선택한 다음 항목만 설정 화면과 검색 결과에 포함한다.

- 다른 브라우저 데이터 가져오기, 기본 브라우저 지정, 이전 창·탭 복원.
- 검색 엔진 제안.
- Privacy and security 전체.
- Passwords and autofill 전체.
- 다운로드 저장 위치(`Save files to`).
- Languages 전체.
- AI controls 전체.
- Permissions and data 전체.
- 기존 More from Mozilla 위치의 Mono 브라우저 설명.
- Extensions and themes 연결.

원본 설정 모듈과 저장 기능은 보존하고 사용자 지정 설정 구성에서 노출 범위를 정한다.
로그인·도움말·확장 관리 등 설정 문서를 벗어나는 탐색은 일반 브라우저 창에서 연다.

## 8. 구현 위치와 유지 방법

| 대상 | 소스 경로 |
| --- | --- |
| 공통 디자인 값 | `browser/base/content/custom-ui/design-tokens.css` |
| 사이드바·탭·새 탭·페이지 배치 | `browser/base/content/custom-ui/browser-custom-ui.css` |
| 주소창·탐색·검색 제안 | `browser/base/content/custom-ui/browser-custom-navigation.css` |
| 메뉴·권한 등 팝업 | `browser/base/content/custom-ui/browser-custom-popups.css` |
| 설정 전용 창 생성·재사용 | `browser/base/content/custom-ui/CustomSettingsWindow.sys.mjs` |
| 설정 창의 Mono 헤더·창 제어·외형 | `browser/base/content/custom-ui/browser-custom-settings-window.js`, `browser-custom-settings-window.css`, `custom-settings-titlebar.inc.xhtml` |
| 사용자 지정 창 문서·부분 문서 | `browser/base/content/custom-ui/` |
| 설정 페이지와 Shadow DOM 탐색 | `browser/components/preferences/custom-ui/` |
| 리소스 패키징 | `browser/base/jar.mn`, `browser/components/preferences/jar.mn` |

새 외형은 위의 전용 파일에 추가한다. `browser.customUI.enabled`와 문서의 `custom-ui` 범위를 사용하고 웹페이지 폼까지 전역 스타일을 확장하지 않는다.
Shadow DOM에는 공개 CSS 변수·`::part()`·컴포넌트 내부 스타일 경로를 사용한다.
Mozilla 토큰을 재사용할 때도 색상은 Mono 팔레트에 연결하고 배경·글자·경계선용 의미 토큰을 사용한다.

기존 Firefox UI는 외형과 기능 연결을 단계적으로 이전한다. 탭·탐색·메뉴 컨트롤러를 보존하고, 대응 기능과 상태 전달을 옮긴 뒤 기존 화면을 제거한다.
전환 범위와 남은 화면은 [사용자 지정 UI 전환 목록](browser/base/content/custom-ui/README.md)에서 관리한다.

사용자가 디자인을 바꾸면 이 문서와 해당 토큰·스타일을 함께 갱신한다. 이전 시안·원본 Firefox 외형·구현 중인 임시 상태를 새로운 확정 기준으로 취급하지 않는다.
