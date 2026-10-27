# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

custom-ui-brand = Mono

custom-ui-navigation =
    .aria-label = 페이지 탐색

custom-ui-navigation-back =
    .aria-label = 뒤로
    .title = 뒤로

custom-ui-navigation-forward =
    .aria-label = 앞으로
    .title = 앞으로

custom-ui-navigation-reload =
    .aria-label = 새로고침
    .title = 새로고침

custom-ui-navigation-stop =
    .aria-label = 로딩 중지
    .title = 로딩 중지

custom-ui-address-new-tab = New Tab
    .aria-label = 주소 또는 검색어 입력

custom-ui-address-input =
    .aria-label = 주소 또는 검색어 입력

custom-ui-page-settings =
    .aria-label = 페이지 설정
    .title = 페이지 설정

custom-ui-page-panel =
    .aria-label = 페이지 설정

custom-ui-page-extensions =
    .aria-label = 고정한 확장 프로그램

custom-ui-page-bookmark =
    .aria-label = 즐겨찾기에 추가
    .title = 즐겨찾기에 추가

custom-ui-page-bookmark-edit =
    .aria-label = 즐겨찾기 편집
    .title = 즐겨찾기 편집

custom-ui-page-translate =
    .aria-label = 페이지 번역
    .title = 페이지 번역

custom-ui-page-extensions-manage =
    .aria-label = 확장 프로그램 관리
    .title = 확장 프로그램 관리

custom-ui-page-zoom =
    .aria-label = 확대/축소

custom-ui-page-zoom-out =
    .aria-label = 축소
    .title = 축소

custom-ui-page-zoom-in =
    .aria-label = 확대
    .title = 확대

# Variables:
#   $zoom (Number) - The current zoom level of the page in percent.
custom-ui-page-zoom-reset = { $zoom }%
    .aria-label = 현재 { $zoom }%, 기본 크기로 되돌리기
    .title = 기본 크기로 되돌리기

custom-ui-page-site-settings = 사이트 설정

custom-ui-page-site-view =
    .title = 사이트 설정

custom-ui-page-site-info = 사이트 정보
custom-ui-page-connection-secure = 보안 연결
custom-ui-page-connection-not-secure = 안전하지 않음
custom-ui-page-tracking-protection = 추적 방지
custom-ui-page-permissions = 권한

# Variables:
#   $permission (String) - The name of the site permission, such as camera.
custom-ui-page-permission-clear =
    .aria-label = { $permission } 권한 초기화
    .title = 권한 초기화

custom-ui-page-clear-site-data = 쿠키 및 사이트 데이터 삭제

custom-ui-menu-button =
    .aria-label = 브라우저 메뉴
    .title = 브라우저 메뉴 열기

custom-ui-tabstrip-new-tab =
    .label = New Tab


custom-ui-sidebar-collapse =
    .aria-label = 탭 사이드바 접기
    .title = 탭 사이드바 접기

custom-ui-sidebar-expand =
    .aria-label = 탭 사이드바 펼치기
    .title = 탭 사이드바 펼치기

custom-ui-space = 개인

custom-ui-space-button =
    .aria-label = 개인 작업공간 — 전환 기능 준비 중
    .title = 작업공간 전환 기능은 아직 연결되지 않았습니다.

custom-ui-settings = 설정

custom-ui-settings-title = Mono 설정

custom-ui-settings-window-title = Mono 설정

custom-ui-settings-window-minimize =
    .aria-label = { browser-window-minimize-button.tooltiptext }
    .title = { browser-window-minimize-button.tooltiptext }

custom-ui-settings-window-maximize =
    .aria-label = { browser-window-maximize-button.tooltiptext }
    .title = { browser-window-maximize-button.tooltiptext }

custom-ui-settings-window-restore =
    .aria-label = { browser-window-restore-down-button.tooltiptext }
    .title = { browser-window-restore-down-button.tooltiptext }

custom-ui-settings-window-close =
    .aria-label = { browser-window-close-button.tooltiptext }
    .title = { browser-window-close-button.tooltiptext }

custom-ui-settings-navigation =
    .heading = Mono 설정
    .aria-label = 설정 카테고리

custom-ui-settings-general-heading =
    .heading = 일반

custom-ui-settings-general-navigation = 일반
    .title = 일반

custom-ui-settings-appearance-heading =
    .heading = 모양

custom-ui-settings-appearance-navigation = 모양
    .title = 모양

custom-ui-settings-theme-group =
    .label = 테마
    .description = 사이드바와 창의 색입니다. 밝기는 시스템 설정을 따릅니다.

custom-ui-settings-theme-mono =
    .label = 모노

custom-ui-settings-theme-sky =
    .label = 스카이

custom-ui-settings-theme-ocean =
    .label = 오션

custom-ui-settings-theme-lavender =
    .label = 라벤더

custom-ui-settings-theme-mint =
    .label = 민트

custom-ui-settings-theme-rose =
    .label = 로즈

custom-ui-settings-theme-peach =
    .label = 피치

custom-ui-settings-theme-sand =
    .label = 샌드

custom-ui-settings-theme-sage =
    .label = 세이지

custom-ui-settings-theme-slate =
    .label = 슬레이트

custom-ui-settings-tabs-heading =
    .heading = 탭과 탐색

custom-ui-settings-tabs-navigation = 탭과 탐색
    .title = 탭과 탐색

custom-ui-settings-tab-groups-heading =
    .label = 탭 그룹

custom-ui-settings-fold-heading =
    .heading = Fold

custom-ui-settings-fold-navigation = Fold
    .title = Fold

custom-ui-settings-fold-group =
    .label = 사이트 사이드바 접기
    .description = 사이트의 사이드바를 Mono 사이드바로 접어 넣습니다. 사이트마다 처음부터 접을지 고릅니다.

custom-ui-settings-fold-enabled =
    .label = Fold 사용

# Variables:
#   $name (String) - The site's name, such as Reddit.
#   $host (String) - The site's address, such as reddit.com.
custom-ui-settings-fold-site =
    .label = { $name }
    .description = { $host }

# Variables:
#   $name (String) - The site's name, such as Reddit.
custom-ui-settings-fold-site-toggle =
    .aria-label = { $name }에서 Fold 사용

custom-ui-settings-connect-heading =
    .heading = Connect

custom-ui-settings-connect-navigation = Connect
    .title = Connect

custom-ui-settings-connect-group =
    .label = 연결할 서비스
    .description = 다른 서비스의 정보를 Mono에서 함께 씁니다.

custom-ui-settings-connect-google-calendar =
    .label = Google Calendar
    .description = 일정을 Mono 캘린더에서 함께 봅니다.

custom-ui-settings-connect-button =
    .label = Connect

custom-ui-settings-privacy-heading =
    .heading = 개인 정보와 보안

custom-ui-settings-privacy-navigation = 개인 정보와 보안
    .title = 개인 정보와 보안

custom-ui-settings-privacy-more =
    .label = 더 보기

custom-ui-settings-languages-link =
    .label = 언어와 번역
    .description = 웹사이트 언어, 번역, 맞춤법 검사

custom-ui-settings-passwords-link =
    .label = 비밀번호와 자동 완성
    .description = 저장한 비밀번호, 결제 수단, 주소

custom-ui-settings-permissions-link =
    .label = 사이트 권한과 데이터
    .description = 위치, 카메라, 알림 등 사이트가 쓰는 기능

custom-ui-settings-ai-link =
    .label = AI 기능
    .description = 브라우저에 들어 있는 AI 기능의 사용 여부

custom-ui-settings-languages-heading =
    .heading = 언어와 번역

custom-ui-settings-passwords-heading =
    .heading = 비밀번호와 자동 완성

custom-ui-settings-permissions-heading =
    .heading = 사이트 권한과 데이터

custom-ui-settings-ai-heading =
    .heading = AI 기능

custom-ui-settings-extensions-navigation = 확장 프로그램
    .title = 확장 프로그램

custom-ui-settings-default-active =
    .label = Mono가 기본 브라우저입니다.

custom-ui-settings-default-inactive =
    .label = Mono를 기본 브라우저로 설정합니다.

custom-ui-settings-button =
    .aria-label = 설정
    .title = 설정 열기

custom-ui-assistant = 에이전트 상태

custom-ui-assistant-button =
    .aria-label = 에이전트 상태
    .title = 에이전트 상태 카드 열기 또는 닫기

custom-ui-assistant-title = 에이전트 연결 대기

custom-ui-assistant-close =
    .aria-label = 에이전트 상태 카드 닫기
    .title = 닫기

custom-ui-assistant-unavailable = 에이전트가 아직 연결되지 않았습니다. 작업 실행 기능이 연결되면 이곳에 진행 상황이 표시됩니다.

custom-ui-history-title = 작업 상태

custom-ui-history-empty = 진행 중인 작업이 없습니다.

custom-ui-pause =
    .aria-label = 일시정지 — 에이전트 연결 필요
    .title = 일시정지 — 에이전트 연결 필요

custom-ui-stop =
    .aria-label = 중지 — 에이전트 연결 필요
    .title = 중지 — 에이전트 연결 필요

custom-ui-run-row-unavailable = 에이전트 연결 필요

custom-ui-agent-orb =
    .aria-label = 에이전트 현황 열기
    .title = 에이전트 현황 열기

custom-ui-agent-stop =
    .aria-label = 에이전트 멈추기
    .title = 에이전트 멈추기

custom-ui-agent-approve = 진행

custom-ui-agent-takeover = 내가 할게요

custom-ui-agent-resume = 이어서

custom-ui-agent-handoff = 직접 할게요

custom-ui-agent-next-click = 다음 클릭

custom-ui-agent-confirm-label = 확인

custom-ui-agent-done-label = 완료

custom-ui-agent-progress = { $step }/{ $total } · { $seconds }초

custom-ui-agent-progress-open = { $seconds }초

custom-ui-agent-paused-title = 직접 조작 중이라 멈췄어요

custom-ui-agent-stopped-title = 멈췄어요

custom-ui-agent-paused-detail = { $step }/{ $total }에서 멈춤

custom-ui-agent-paused-detail-open = 직접 조작 중

custom-ui-agent-done-title = 완료 · { $headline }

custom-ui-agent-done-title-plain = 완료

custom-ui-agent-done-detail = { $steps }단계 · { $seconds }초

custom-ui-agent-done-detail-saved = { $steps }단계 · { $seconds }초 · 경로 저장됨

custom-ui-agent-done-summary = { $headline } · { $seconds }초

custom-ui-agent-done-summary-plain = { $seconds }초

custom-ui-agent-tab-working = { $title }, 에이전트 작업 중 { $step }/{ $total }

custom-ui-agent-tab-working-open = { $title }, 에이전트 작업 중

custom-ui-agent-tab-confirm = { $title }, 에이전트가 확인을 기다리는 중

custom-ui-agent-tab-paused = { $title }, 에이전트 멈춤

custom-ui-agent-tab-done = { $title }, 에이전트 작업 완료

custom-ui-notice-label = 새 기능

custom-ui-notice-close =
    .aria-label = 알림 닫기
    .title = 닫기

custom-ui-archive-button =
    .aria-label = 보관함
    .title = 보관함
# Variables:
#   $percent (Number) - How much of the running downloads has arrived, from 0 to 100
custom-ui-archive-button-downloading =
    .aria-label = 다운로드 중 { $percent }% · 다운로드 보기
    .title = 다운로드 중 { $percent }%
custom-ui-archive-button-downloading-unknown =
    .aria-label = 다운로드 중 · 다운로드 보기
    .title = 다운로드 중
custom-ui-archive-button-downloaded =
    .aria-label = 다운로드 완료 · 다운로드 보기
    .title = 다운로드 완료

custom-ui-archive-title-history = 방문 기록

custom-ui-archive-title-bookmarks = 북마크

custom-ui-archive-title-downloads = 다운로드

custom-ui-archive-title-calendar = 캘린더

custom-ui-archive-closed-tabs = 최근 닫은 탭

custom-ui-archive-history-empty = 아직 방문 기록이 없어요

custom-ui-archive-bookmarks-empty = 저장한 북마크가 없어요

custom-ui-archive-downloads-empty = 다운로드한 파일이 없어요

custom-ui-archive-calendar-empty = 할 일이 없어요

custom-ui-archive-folder-toolbar = 북마크 도구 모음

custom-ui-archive-folder-menu = 북마크 메뉴

custom-ui-archive-folder-other = 기타 북마크

custom-ui-archive-folder-mobile = 모바일 북마크

custom-ui-archive-download-starting = 시작하는 중…

custom-ui-archive-download-paused = 일시 정지됨

custom-ui-archive-download-canceled = 취소됨

custom-ui-archive-download-failed = 실패

custom-ui-archive-download-blocked = 차단됨

custom-ui-archive-download-missing = 파일이 삭제됨

custom-ui-archive-download-more =
    .aria-label = 더 보기
    .title = 더 보기

custom-ui-archive-download-rename =
    .label = 이름 바꾸기

custom-ui-archive-download-show =
    .label = 폴더에서 열기

custom-ui-archive-download-delete =
    .label = 삭제

custom-ui-archive-download-rename-field =
    .aria-label = 파일 이름

## Calendar: things to do with an optional due day and time.

custom-ui-calendar-input =
    .placeholder = 할 일 추가
    .aria-label = 새 할 일

custom-ui-calendar-date-button =
    .title = 기한 날짜

custom-ui-calendar-time-button =
    .title = 기한 시간

custom-ui-calendar-date-chip = 날짜

custom-ui-calendar-time-chip = 시간

custom-ui-calendar-submit =
    .aria-label = 할 일 추가
    .title = 할 일 추가

custom-ui-calendar-next-week = 다음 주

custom-ui-calendar-pick-date = 날짜 선택…

custom-ui-calendar-clear-date = 기한 없음

custom-ui-calendar-clear-time = 시간 없음

custom-ui-calendar-previous-month =
    .aria-label = 이전 달
    .title = 이전 달

custom-ui-calendar-next-month =
    .aria-label = 다음 달
    .title = 다음 달

custom-ui-calendar-overdue = 기한 지남

custom-ui-calendar-no-date = 날짜 없음

custom-ui-calendar-completed = 완료됨

# Variables:
#   $title (String) - The title of the task.
custom-ui-calendar-complete =
    .aria-label = { $title } 완료

custom-ui-calendar-more =
    .aria-label = 더 보기
    .title = 더 보기

custom-ui-calendar-edit = 편집

custom-ui-calendar-change-date = 날짜 변경

custom-ui-calendar-change-time = 시간 변경

custom-ui-calendar-delete = 삭제

custom-ui-calendar-edit-field =
    .aria-label = 할 일 제목

## Card on the new tab screen listing the tasks due today.

custom-ui-due-title = 오늘 마감

custom-ui-due-close =
    .aria-label = 오늘은 그만 보기
    .title = 오늘은 그만 보기

custom-ui-due-open = 캘린더에서 보기

# Variables:
#   $count (Number) - How many more tasks are due today than the card lists.
custom-ui-due-more = { $count }개 더 보기

## Archive search and row removal.

custom-ui-archive-search-history =
    .placeholder = 방문 기록 검색
    .aria-label = 방문 기록 검색

custom-ui-archive-search-bookmarks =
    .placeholder = 북마크 검색
    .aria-label = 북마크 검색

custom-ui-archive-search-downloads =
    .placeholder = 다운로드 검색
    .aria-label = 다운로드 검색

custom-ui-archive-search-calendar =
    .placeholder = 할 일 검색
    .aria-label = 할 일 검색

custom-ui-archive-search-clear =
    .aria-label = 검색어 지우기
    .title = 지우기

custom-ui-archive-search-empty = 검색 결과가 없어요

custom-ui-archive-searching =
    .aria-label = 검색하는 중

custom-ui-archive-remove-history =
    .aria-label = 방문 기록에서 삭제
    .title = 방문 기록에서 삭제

custom-ui-archive-remove-closed =
    .aria-label = 목록에서 지우기
    .title = 목록에서 지우기

custom-ui-archive-remove-bookmark =
    .aria-label = 북마크 삭제
    .title = 북마크 삭제

## Fold: a page's own sidebar folded into the tab sidebar.
## Variables:
##   $site (String) - The site name, such as "Reddit".

custom-ui-fold-switch =
    .aria-label = 사이드바 보기

custom-ui-fold-switch-tabs =
    .aria-label = 탭
    .title = 탭

custom-ui-fold-switch-site =
    .aria-label = { $site } 메뉴
    .title = { $site } 메뉴

custom-ui-fold-menu =
    .aria-label = { $site } 메뉴

custom-ui-fold-loading = 메뉴를 읽는 중…

custom-ui-fold-unavailable = 이 페이지의 메뉴를 가져오지 못했어요

# A button at the end of a menu row that lists the row's other actions.
# Variables:
#   $item (String) - The row's label, such as "r/firefox".
custom-ui-fold-more =
    .aria-label = { $item } 더 보기
    .title = { $item } 더 보기

# The button after the reload button that turns Fold on or off for the
# selected page's site.
custom-ui-fold-turn-off =
    .aria-label = Fold 끄기
    .title = Fold 끄기

custom-ui-fold-turn-on =
    .aria-label = Fold 켜기
    .title = Fold 켜기

custom-ui-page-fold = 이 사이트에서 Fold 사용

# The splitter of the column beside the tab list (CustomSidePanel).
custom-ui-side-panel-resize =
    .aria-label = 패널 폭 조절

## Capture Fold: copies the selected page's navigation for an AI to write
## its Fold rule. Shown in the app menu's More Tools view.

custom-ui-fold-capture =
    .label = Capture Fold

custom-ui-fold-capture-copied = Fold 캡처를 복사했어요

custom-ui-fold-capture-failed = 이 페이지는 캡처할 수 없어요
