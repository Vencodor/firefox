# 사용자 지정 브라우저 UI 전환

`browser.customUI.enabled`를 켜면 `custom-ui` 속성이 있는 문서에 사용자 지정 외형을 적용한다.
화면을 먼저 이전하고 기능 경로를 확인한 뒤 대응하는 Firefox UI를 단계적으로 교체한다.

색상·로고·모서리·간격 등 제품 외형은 저장소 루트의 [Mono UI Style](../../../../Style.md)을 기준으로 한다.

## 구현 경계

| 파일 | 담당 |
| --- | --- |
| `browser.xhtml`, `browser-box.inc.xhtml` | 브라우저 창 조립과 네이티브 기능 슬롯 연결 |
| `custom-*.inc.xhtml` | 사용자 지정 사이드바 헤더·새 탭 화면·AI 패널 |
| `design-tokens.css` | 브라우저와 설정에서 공유하는 색상·간격·모서리·그림자 |
| `browser-custom-ui.css`, `browser-custom-ui.js` | 사이드바·탭·페이지 배치와 사용자 지정 UI 상태 |
| `browser-custom-navigation.css` | 네이티브 주소 입력·탐색·검색 제안의 사용자 지정 외형 |
| `browser-custom-sidebar-navigation.js`, `browser-custom-sidebar-navigation.css`, `custom-navigation-overlays.inc.xhtml` | 사이드바 도메인·탐색, 중앙 주소 편집, 호버 창 제어. 기존 주소창과 탐색 명령 유지 |
| `browser-custom-site-settings.js` | 기존 Firefox 사이트 정보·권한 패널을 중앙에 표시하고 페이지 정보로 연결 |
| `browser-custom-popups.css` | 네이티브 메뉴·하위 보기·브라우저 팝업의 사용자 지정 외형 |
| `browser-custom-agent.js`, `browser-custom-agent.css`, `custom-agent-hud.inc.xhtml` | 에이전트 상태 표시: 사이드바 탭 행, 오른쪽 아래 오브·말풍선, '다음 클릭' 표시, 새 탭 Run 버튼. 에이전트는 `CustomAgentUI.connect()`로 연결하고 상태는 `setState()`로 알린다 |
| `custom-urlbar-run.sys.mjs` | 주소창 검색 제안의 Run 행(동적 제안 공급자) |
| `browser-custom-notice.js`, `browser-custom-notice.css`, `custom-notice-sidebar.inc.xhtml` | 새 기능 알림 카드(새 탭 검색 상자 아래, 사이드바 아래쪽). 내용은 `browser.customUI.notice`, 닫은 알림은 `browser.customUI.noticeDismissed`에 기록 |
| `browser-custom-observation.js`, `browser-custom-observation.css`, `custom-observation-panel.inc.xhtml` | 앱 메뉴의 ‘페이지 관찰’ 항목과 도구 모음 버튼에서 여는 오른쪽 페이지 관찰 패널. 후보 요소를 표시하고 선택 항목을 페이지에서 강조 |
| `CustomSettingsWindow.sys.mjs`, `browser-custom-settings-window.js`, `browser-custom-settings-window.css`, `custom-settings-titlebar.inc.xhtml` | 설정 전용 창의 생성·재사용, Mono 헤더·창 제어 및 일반 창과의 분리 |
| `../../../components/preferences/custom-ui/` | 설정 페이지·설정 탐색·하위 대화상자의 사용자 지정 외형 |

사용자 지정 파일은 `browser/base/jar.mn`과 설정의 `jar.mn`에서 패키징한다.
`custom-*.inc.xhtml`은 창 문서에 전처리되어 포함된다.
주소창·세로 탭·메뉴·설정의 Firefox 컨트롤러는 현재 기능 연결을 담당한다.

## 전환 상태

| 화면 | 상태 |
| --- | --- |
| 사이드바 헤더, 새 탭 표면, AI 패널 틀 | 사용자 지정 컴포넌트; 하단 개인·에이전트·설정 버튼 제거 |
| 네이티브 세로 탭·탭 그룹 | 사용자 지정 외형, 기존 탭 동작 연결 |
| 사이드바 탐색·주소창·검색 제안 | 도메인 표시, 전체 주소 중앙 편집, 기존 탐색·검색 제안 연결. 비활성 이전·앞으로 자리 유지 |
| 에이전트 Run 버튼·Run 제안 행·탭 상태·오브와 말풍선·'다음 클릭' 표시 | 화면과 연결 지점 구현. 에이전트가 없으면 Run은 비활성이며, 모든 상태는 `browser.customUI.agentMock`으로 확인 |
| 기능 알림 카드 | 새 탭·사이드바 카드 구현(일러스트는 임시 그림). 오류 페이지 카드는 이전 대기 |
| 프로필 메뉴·에이전트 현황 패널의 작업 목록 | 보류 |
| 앱 메뉴·설정 드롭다운·메뉴 하위 보기 | 사용자 지정 외형, 기존 명령 연결 |
| 탭·페이지 우클릭 메뉴 | 사용자 지정 외형, 기존 명령 연결 |
| 다운로드·사이트 정보·권한·보호·알림·확장·북마크 편집·번역 팝업 | 공통 외형 적용, 각 기능별 상세 화면 확인 대상 |
| 설정 페이지·설정 하위 창 | 설정 명령은 별도 창으로 연결; 사용자 선택 항목과 Mono 설명을 표시하고 기존 검색·설정 저장·하위 창 재사용 |
| 북마크·방문 기록 Library 독립 창 | 이전 대기: `chrome://browser/content/places/places.xhtml` |
| 비밀번호 관리 | 이전 대기: `about:logins` |
| 확장 관리 | 이전 대기: `about:addons` |
| 전체 다운로드 화면 | 이전 대기: `about:downloads` |
| 페이지 찾기·페이지 상단 알림 막대 | 이전 대기: `findbar`와 NotificationBox |
| 인쇄 설정·인쇄 미리 보기 | 이전 대기: 독립 인쇄 문서 |

사이드바 탐색은 일반 세로 탭 창에서만 적용하고 사용자 지정 도구 모음·전체 화면·설정 전용 창에서는 기존 경로를 따른다.
주소 편집과 페이지 설정에는 어두운 배경을 넣지 않으며, 공통 그림자와 짧은 애니메이션만 적용한다.

페이지 관찰은 Mono 앱 메뉴에서 ‘페이지 관찰’을 선택해 연다. 지원 페이지에서 ‘관찰 시작’을 누르면 후보 요소 목록이 표시되고, 목록 항목을 눌러 해당 요소를 페이지에서 강조할 수 있다. ‘다시 관찰’은 현재 페이지를 다시 읽으며, 패널을 닫으면 관찰과 강조 표시를 지운다.

다음 화면도 전용 사용자 지정 파일에서 구현하고 기존 명령·설정 경로에 연결한다.
기능과 접근성 이름·키보드 조작·오류 표시를 옮긴 후 해당 네이티브 UI를 제거한다.
웹페이지의 폼과 운영체제 파일 선택 창은 이 브라우저 UI 스타일 범위에 포함하지 않는다.
