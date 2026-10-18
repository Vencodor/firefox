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
| `browser-custom-sidebar-navigation.js`, `browser-custom-sidebar-navigation.css`, `custom-navigation-overlays.inc.xhtml` | 사이드바 도메인·탐색, 중앙 주소 편집, 호버 창 제어, 사이드바 폭 단계 조절(42px 단위로 부드럽게 이동, 최소 168px, 100px 미만으로 끌면 접힘, 조절 중 콘텐츠 영역 블러). 기존 주소창과 탐색 명령 유지 |
| `browser-custom-site-settings.js` | 기존 Firefox 사이트 정보·권한 패널을 중앙에 표시하고 페이지 정보로 연결 |
| `browser-custom-popups.css` | 네이티브 메뉴·하위 보기·브라우저 팝업의 사용자 지정 외형 |
| `browser-custom-agent.js`, `browser-custom-agent.css`, `custom-agent-hud.inc.xhtml` | 에이전트 상태 표시: 사이드바 탭 행, 오른쪽 아래 오브·말풍선, '다음 클릭' 표시. 에이전트는 `CustomAgentUI.connect()`로 연결하고 상태는 `setState()`로 알린다 |
| `custom-urlbar-run.sys.mjs` | 주소창 검색 제안의 ‘Chat’ 행. 기존 동적 제안 선택 경로에서 채팅 명령을 실행 |
| `browser-custom-chat.js`, `agent-chat.html`, `agent-chat.js`, `agent-chat.css` | Mono 메뉴의 ‘Chat with Agent’에서 여는 독립 채팅 탭. 질문 초안, 대화 표시, 스트리밍 응답과 중지 처리 |
| `browser-custom-archive.js`, `browser-custom-archive.css`, `custom-archive.inc.xhtml` | 사이드바 하단 보관함 버튼과 방문 기록(최근 닫은 탭 포함)·북마크·다운로드 화면. 기존 `PlacesQuery`, 북마크 트리, `SessionStore`, `Downloads` 데이터를 읽어 표시한다. 항목 클릭 동작은 아직 연결하지 않았다 |
| `browser-custom-switch.js` | 보관함과 Fold가 함께 쓰는 아이콘 탭 전환 토글(`CustomSwitch`): 흰 선택 표시 이동, 좌우 스크롤 전환, 방향키 |
| `browser-custom-fold.js`, `browser-custom-fold.css`, `custom-fold-switch.inc.xhtml`, `custom-fold.inc.xhtml`, `custom-fold-dock.inc.xhtml` | Fold: 탭 목록 오른쪽(Firefox 사이드바 패널 자리)에 붙는 Fold 열과, 열을 닫았거나 붙일 공간이 없을 때 쓰는 주소 영역 아래의 탭/사이트 전환 토글·Fold 메뉴 화면. 열 폭은 `browser.customUI.fold.dockWidth`, 열을 닫은 사이트는 `browser.customUI.fold.undockedSites`에 기록한다. 열을 닫은 사이트에서는 사이드바 오른쪽 아래, 보관함 버튼 맞은편의 Fold 펼치기 버튼(`custom-archive.inc.xhtml`의 하단 줄)으로 다시 붙인다. 웹페이지의 사이드바를 숨기고 `browser/components/fold/`의 전사 결과를 보관함 행·묶음 제목 스타일로 표시한다. 항목을 누르면 웹페이지의 원래 요소를 대신 클릭한다. More Tools 화면의 Capture Fold 항목도 여기서 추가한다 |
| `browser-custom-notice.js`, `browser-custom-notice.css`, `custom-notice-sidebar.inc.xhtml` | 새 기능 알림 카드(새 탭 검색 상자 아래, 사이드바 아래쪽). 내용은 `browser.customUI.notice`, 닫은 알림은 `browser.customUI.noticeDismissed`에 기록 |
| `browser-custom-observation.js`, `browser-custom-observation.css`, `custom-observation-panel.inc.xhtml` | 앱 메뉴 More Tools의 ‘Observe Page’ 항목과 도구 모음 버튼에서 여는 오른쪽 페이지 관찰 패널. 후보 요소를 표시하고 선택 항목을 페이지에서 강조 |
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
| 사이드바 탐색·주소창·검색 제안 | 도메인 표시, 전체 주소 중앙 편집, 기존 탐색·검색 제안 연결. 비활성 탐색 버튼은 자리를 유지하며 연하게 표시 |
| 에이전트 탭 상태·오브와 말풍선·'다음 클릭' 표시 | 화면과 연결 지점 구현. 새 탭의 Run 버튼은 제거했고 `CustomAgentUI.run()` 연결 지점은 유지. 모든 상태는 `browser.customUI.agentMock`으로 확인 |
| 에이전트 채팅 탭 | 홈 검색 추천의 대화 명령에서 질문을 새 네이티브 탭으로 전달하는 전환은 확정. 채팅 UI 배치는 잠정적. 연결되어 있으면 첫 질문을 한 번 보내고, 미연결이면 초안으로 보존. 메뉴와 ‘새 대화’는 빈 새 탭을 연다 |
| Fold(사이트 사이드바 전사) | Reddit·Gemini 규칙과 공통 전사 엔진 구현. 접속 시 웹페이지 사이드바를 접고 탭 목록 오른쪽 열에 메뉴를 보여 준다. 열을 닫으면 주소 영역 아래 토글로 메뉴를 연다. 페이지 설정 패널에서 사이트별로 끈다. 첫 안내 말풍선과 표시할 항목 편집은 이후 작업 |
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

페이지 관찰은 Mono 앱 메뉴의 More Tools에서 ‘Observe Page’를 선택해 연다. 지원 페이지에서 ‘관찰 시작’을 누르면 ‘행동 요소(action)’, ‘페이지 맥락(context)’, ‘선택 번역(translation)’ 세 가지 중요도·정렬 프로파일을 전환하며 후보 요소·맥락 블록·번역 대상 블록과 점수 근거를 관측하고, 목록 항목을 눌러 해당 요소를 페이지에서 강조할 수 있다. ‘다시 관찰’은 현재 페이지를 다시 읽으며, 패널을 닫으면 관찰과 강조 표시를 지운다.

채팅은 기존 `CustomAgentUI.connect(adapter)`에 선택적인 `chat({ conversationId, messages, signal, onDelta })` 메서드를 연결한다. `messages`는 `{ role, content }` 배열이며 현재 대화의 질문과 완료된 답변만 전달한다. `chat()`은 최종 답변 문자열을 반환하는 Promise를 제공하거나, `onDelta(text)`로 추가되는 답변 조각을 전달한 뒤 완료한다. `signal`이 취소되면 어댑터도 요청을 중단해야 한다. UI는 취소·연결 변경·페이지 이탈 뒤의 늦은 응답을 반영하지 않는다. 채팅 전용 어댑터는 웹 작업 Run을 활성화하지 않는다.

모델 연결·외부 전송·웹페이지 수집은 이 화면에서 수행하지 않는다. 채팅 내용과 초안은 각 문서에만 보관하며 새로고침·탭 닫기 뒤에는 복원하지 않는다. 기존 `agentMock`은 작업 상태 확인용이며 채팅 답변을 생성하지 않는다.

홈의 대화 전환은 `Browser:AgentChat` 명령과 검색 추천 공급자가 공유하는 `CustomAgentChatUI.startChat(query)`에서 처리한다. 추천 선택 시 Firefox가 주소 입력을 되돌리므로 공급자는 선택한 결과의 `payload.query`를 명시적으로 전달한다. 첫 질문은 새 탭의 browser에 연결한 메모리에서 문서 초기화 시 한 번만 가져오며 URL이나 세션 저장소에 넣지 않는다. 채팅 화면을 수정해도 이 명령과 질문 전달 경로는 유지한다.

다음 화면도 전용 사용자 지정 파일에서 구현하고 기존 명령·설정 경로에 연결한다.
기능과 접근성 이름·키보드 조작·오류 표시를 옮긴 후 해당 네이티브 UI를 제거한다.
웹페이지의 폼과 운영체제 파일 선택 창은 이 브라우저 UI 스타일 범위에 포함하지 않는다.
