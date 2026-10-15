Mono 페이지 관찰
================

사용법
왼쪽 위 Mono 메뉴에서 '페이지 관찰'을 누르고 '관찰 시작'을 선택한다.
도구 모음이 표시되는 배치에서는 돋보기(페이지 관찰) 버튼도 사용할 수 있다.
파란색은 필터를 통과한 후보, 주황색은 검사 목록에서 선택한 후보다.
번호는 현재 관찰에서만 유효하다. 목록의 세부 정보에서 이름, 역할,
가능한 작업, 카드/행 문맥과 링크 주소를 확인한다.
페이지 이동, 스크롤, 크기 변경, 입력 및 DOM 변경 시 표시가 지워진다.
'다시 관찰'로 갱신한다. 탭 전환, 패널 닫기와 관찰 중지는 세션을 정리한다.

구조
AgentObservation.sys.mjs
  브라우저 탭에 소속된 관찰 세션. 보이는 프레임의 비동기 수집을 조정하고
  후보/동작 예산을 적용해 직렬화 가능한 결과를 만든다.
actors/AgentObservationChild.sys.mjs
  각 문서의 DOM 수집, 실제 노드 참조, 변경 감지 및 표시 수명을 소유한다.
actors/AgentObservationParent.sys.mjs
  문서의 무효화 통지를 소유 브라우저 세션에 전달한다.
observation/DOMObservation.sys.mjs
  기존 Python 실험 v7의 수집/필터 규칙을 JavaScript로 이식했다.
  collectDOMObservation은 문서별 원시 스냅샷과 비공개 노드 Map을 반환한다.
  filterCandidates는 JSON만 처리한다. 선택 상자 옵션도 동작 예산에 포함된다.
observation/ObservationOverlay.sys.mjs
  Gecko의 anonymous content 표시층. 사이트 DOM/스타일은 수정하지 않으며
  pointer-events:none으로 클릭을 가로채지 않는다.
browser/base/content/custom-ui/browser-custom-observation.*
  관찰 API를 소비하는 검사 UI. 기존 CustomAgentUI의 실행/상태 연결과 분리된다.

후속 에이전트 연결
resource:///modules/agent/AgentObservation.sys.mjs에서 AgentObservationSession을
가져와 new AgentObservationSession(browser, {onInvalidated})로 생성한다.
await session.observe()는 schemaVersion=1, id, page, viewport, elements,
targets_by_operation, coverage, timing을 반환한다.
element.handle은 observationId/frameId/documentId/nodeId를 포함하며,
같은 문서의 같은 관찰 안에서만 유효하다. DOM 참조는 콘텐츠 actor에 남는다.
session.highlight(handle)는 현재 후보를 표시할 수 있는지 boolean을 반환한다.
await session.clear()는 결과/표시/리스너를, await session.destroy()는 세션을 정리한다.
탭당 활성 세션은 하나이며 새 세션이 이전 세션을 종료한다.

모델 어댑터와 실행기는 아직 없다. 모델 입력을 만들 때 elements의 context와
coverage를 보존해야 한다. UI나 DOM 수집기에 모델 호출/정책/실행을 넣지 않는다.
미래 실행기는 handle 소유권뿐 아니라 현재 이름/값/상태/가림과 실제 클릭점을
실행 직전에 다시 검증해야 한다. highlight 성공은 실행 가능성 보증이 아니다.
CustomAgentUI.connect()는 기존 상태 UI의 연결 지점으로 유지된다.

현재 범위
http/https/file 문서, 현재 화면에 보이는 조작 후보, 열린 Shadow DOM,
보이는 iframe(최대 깊이 3, 최상위 포함 최대 16문서)을 처리한다.
프레임 수집에는 전체 5초 제한을 두며, 초과한 프레임은 제외 사유를 기록한다.
기본 예산은 동작 250개, 본문 6000자, 요소 문맥 320자다.
본문 잘림, 동작 예산 초과 및 프레임 수집 실패를 결과/검사 UI에 표시한다.
비밀번호와 파일 입력값은 수집하지 않는다. 관찰 데이터는 세션 메모리에만
유지하며 자동 저장, 외부 전송, 모델 호출, 페이지 조작을 수행하지 않는다.

닫힌 Shadow DOM, canvas 내부, 브라우저 내부 페이지와 완전한 접근성 이름
알고리즘은 지원하지 않는다. 프레임 가림/클리핑은 표본 검사이며 CSS 변환된
프레임의 좌표 정확성은 보장하지 않는다. 본문은 전체 문서 읽기 API가 아니다.
MutationObserver/이벤트로 감지되지 않는 CSS 애니메이션이나 스크립트의 값
직접 변경도 있으므로 '다시 관찰'이 필요할 수 있다. 별도 클릭 실행기는 없다.

검증
tests/browser/browser.toml은 실제 콘텐츠 프로세스, 프레임, 강조층, 세션 분리와
무효화를 검사한다. 빌드/검사 실행 결과는 해당 작업의 artifacts에 별도 기록한다.
검사 통과는 모델의 선택 정확도나 여러 단계 웹 작업 성공률을 입증하지 않는다.
