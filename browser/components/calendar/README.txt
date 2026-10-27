Mono 캘린더
===========

사용법
사이드바 왼쪽 아래 보관함 버튼을 누르고 '캘린더'를 고른다. 위쪽 입력칸에
할 일을 쓰고 날짜·시간 칩으로 기한을 정한 뒤 Enter로 추가한다.
원을 누르면 완료되고, 행을 누르면 제목을 그 자리에서 고친다. 더 보기
메뉴에서 기한을 바꾸거나 지운다. 할 일은 특정 웹 페이지에 묶이지 않는다.

구조
CalendarStore.sys.mjs
  할 일의 유일한 저장소. 프로필의 calendar.json(JSONFile)에 저장한다.
  getAll, get, getDue, search, add, update, remove만 노출하고 항상 복사본을
  돌려준다. 바뀔 때마다 "mono-calendar-changed" 관찰자 주제로 { type, id }를
  알리므로 여러 창의 사이드바가 같은 목록을 보여 준다.
browser/base/content/custom-ui/browser-custom-calendar.js
  보관함의 캘린더 화면. 저장소를 읽고 쓰기만 하고 할 일 자체는 들고 있지 않는다.
browser/base/content/custom-ui/browser-custom-dropdown.js
  날짜 빠른 선택 메뉴와 달력(CustomDatePicker)을 그린다.

할 일 형식 (version 1)
  id           문자열 UUID
  kind         "task". 일정(event)은 같은 목록에 kind로 추가할 예정이다.
  title        평문, 최대 2000자
  dueDate      "YYYY-MM-DD" 현지 날짜 또는 null. 종일 일정처럼 시간대와 무관하다.
  dueTime      "HH:MM"(24시간) 또는 null. dueDate가 있을 때만 남는다.
  completedAt  완료한 시각(밀리초) 또는 null
  createdAt    밀리초
  updatedAt    밀리초
  author       "user" 또는 "agent"

에이전트 연동을 위한 원칙
- 에이전트도 UI와 같은 CalendarStore API로 읽고 쓴다. 파일을 직접 다루지 않는다.
  예상 도구: calendar.getDue(from, to) / calendar.search(query) /
  calendar.add(title, dueDate, dueTime) / calendar.update(id, changes).
- 날짜는 자연어 대신 "YYYY-MM-DD"와 "HH:MM"으로 주고받는다. "내일 3시" 같은
  해석은 모델 쪽에서 하고, 저장소는 형식만 검사한다.
- 에이전트가 추가한 할 일은 author: "agent"로 남겨 사용자가 구분하고 검토할 수 있게 한다.
- 지우기는 사용자 확인 없이 에이전트 도구로 노출하지 않는다.
- 형식을 바꿀 때는 SCHEMA_VERSION을 올리고 dataPostProcessor에서 이전 형식을 옮긴다.

아직 없는 것
반복 일정, 알림, 일정(event)과 주/월 보기는 이후 작업이다.
