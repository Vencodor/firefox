Custom Firefox Browser — 프로젝트 지침
이 문서는 Firefox 포크에서 작업하는 코딩 에이전트를 위한 지침이다. 사용자와의 대화와 작업 보고는 한국어로 한다.
목표와 현재 단계
- 저장소: https://github.com/Vencodor/firefox
- 원본: https://github.com/mozilla-firefox/firefox
- Firefox의 Gecko 엔진과 기존 브라우저 기능을 활용해 세로 탭 중심의 자체 브라우저를 만든다.
- 최종 목표는 사용자가 직접 조작하는 속도에 가까운 웹 작업 에이전트다.
- 현재 작업은 실제로 실행되는 브라우저의 UI 기본형 완성이다. 그다음 에이전틱 기능을 설계한다.
- 사용자는 UI 구현 대부분을 AI에게 맡기며, 프론트엔드 학습 과정을 별도로 요구하지 않는다. 필요한 구조와 판단 근거만 간결하게 설명한다.
- 2026-10-14에 사용자가 Windows 로컬 개발 빌드 성공을 보고했다. 실행 및 이후 UI 변경 여부는 다음 세션에서 확인한다.
다음 세션에서 처음 할 일
1. 현재 작업 폴더와 git status, 브랜치, remotes, mozconfig를 확인한다. 아래 경로와 브랜치 이름은 확인 없이 실제 상태라고 단정하지 않는다.
2. 원본 지침과 수정 대상 디렉터리의 추가 지침을 읽고, 사용자가 이미 변경한 코드가 있는지 확인한다.
3. 개발용 Firefox를 실행할 수 있는지 확인하고 기존 세로 탭·사이드바 구현을 살펴본다.
4. 기존 세로 탭을 기반으로 작은 단위의 UI 변경을 시작한다. 전체 저장소 분석이나 장문의 구현계획으로 작업을 미루지 않는다.
UI 기본형
확정된 방향은 세로 탭 중심이다. 아래 상세 배치는 이전 세션에서 제안한 첫 시안이며, 사용자 피드백에 따라 조정한다. 최종 색상·폰트·브랜딩은 아직 정해지지 않았다.
영역	첫 시안	동작
왼쪽 사이드바	고정 탭, 일반 탭, 새 탭, 하단 설정 및 AI 버튼	시작 폭 약 220px, 아이콘 중심으로 접기
상단 도구 모음	뒤로/앞으로, 새로고침, 주소창	현재 웹페이지 위에 표시
중앙	현재 웹페이지	남는 공간을 사용
오른쪽 AI 패널	입력창, 작업 내역 영역, 중단 버튼 자리	기본 닫힘, 시작 폭 약 340px, 열기/닫기 및 크기 조절


- 크기 수치는 고정 규격이 아니라 초기 기준이다. 작은 창에서도 페이지와 주요 조작 요소를 사용할 수 있게 한다.
- AI 패널은 현재 단계에서 UI 틀만 구현한다. 실행하지 않는 기능을 실제로 동작하는 것처럼 표시하지 않는다.
- 작업 순서: 기존 세로 탭 확인 → 배치/색상/간격/선택 표시 정리 → AI 패널 틀 추가.
- 첫 버전에서 워크스페이스, 자동 탭 분류, 복잡한 애니메이션, 자동 숨김을 한꺼번에 추가하지 않는다.
- 먼저 기존 테마 색상과 디자인 변수를 활용한다. 밝은/어두운 테마에서 글자와 선택 상태가 잘 보여야 한다.
구현 원칙
- Firefox는 자신의 UI도 Gecko로 렌더링한다. XHTML/XUL, CSS, JavaScript와 일부 Lit 기반 컴포넌트가 함께 사용된다.
- 기존 세로 탭 기능을 확장한다. 기존 탭을 숨기고 별도의 가짜 탭 목록을 만드는 방식으로 시작하지 않는다.
- 탭 열기/닫기/선택/고정/순서 이동/그룹/세션 복원과 키보드 동작을 유지한다.
- 기존 컨트롤러, 명령, 설정 및 상태 관리 경로를 따른다. 단순 CSS 숨김과 직접 DOM 이동만으로 기능을 구현하지 않는다.
- 일부 컴포넌트는 Shadow DOM을 사용하므로 스타일의 적용 범위를 확인한다. 전역 CSS가 내부 요소까지 적용된다고 가정하지 않는다.
- 새 파일은 관련 jar.mn, moz.build, 스크립트 로딩 및 현지화 등록이 필요한지 확인한다. 파일 생성만으로 빌드에 포함된다고 가정하지 않는다.
- 문자열은 기존 Fluent 현지화 방식과 접근성 이름을 따른다. 아이콘만 있는 버튼에도 이름과 키보드 접근성을 제공한다.
- 탭 사이드바와 AI 패널의 폭/열림 상태를 구분한다. 여러 창, 재실행, 전체 화면에서 기존 상태 관리와 충돌하지 않게 한다.
- 초기 UI 작업에서는 C++/Rust 엔진 코드를 수정하지 않는다. Artifact Build 범위를 벗어날 필요가 생기면 이유를 먼저 설명한다.
- 실제 브라우저 소스와 패키징을 수정한다. 독립 HTML 목업을 브라우저 구현 완료로 보고하지 않는다.
소스 탐색 시작점
아래 경로는 포크 확인 당시 존재했다. 작업 전 현재 체크아웃에서 다시 확인한다.
경로	역할
browser/base/content/browser.xhtml	브라우저 창 문서와 포함 파일 조립
browser/base/content/browser-box.inc.xhtml	사이드바, 세로 탭 슬롯, 웹페이지 표시 영역
browser/base/content/navigator-toolbox.inc.xhtml	탭 표시줄과 상단 도구 모음
browser/base/content/browser-sets.inc.xhtml / browser-sets.js	명령/단축키 선언과 실행 연결
browser/base/content/browser-commands.js	탐색 등 명령의 실제 동작
browser/components/sidebar/browser-sidebar.js	SidebarController, 사이드바 및 세로 탭 제어
browser/components/sidebar/sidebar-main.mjs / sidebar-main.css	사이드바 컴포넌트 구성과 스타일
browser/components/sidebar/SidebarState.sys.mjs	창별 사이드바 상태
browser/components/sidebar/SidebarManager.sys.mjs	공통 설정과 창 사이의 상태 연계
browser/components/tabbrowser/	기존 탭 구현
browser/components/urlbar/	주소창 기능
browser/themes/shared/	브라우저 공통 디자인과 스타일
browser/app/profile/firefox.js	기본 설정 값; 기존 프로필의 사용자 설정과 구별
browser/actors/	브라우저와 웹페이지 측 코드 사이의 통신 예시


세로 탭 관련 설정 예: sidebar.verticalTabs, sidebar.revamp. 설정 존재 여부와 현재 사용 방식을 확인한 뒤 수정한다. 기존 aiwindow/genai 기능도 통합 대상인지 먼저 확인하고, 이름만 보고 프로젝트 AI 패널과 동일하다고 판단하지 않는다.
로컬 빌드: Windows
- 작업 위치 안내: C:\mozilla-source\firefox.
- 빌드 셸: C:\mozilla-build\start-shell.bat으로 여는 MozillaBuild 셸.
- 소스 및 도구 경로는 짧고 공백 없는 경로를 권장한다.
- origin은 개인 포크, upstream은 Mozilla 원본으로 설정하도록 안내했다. 실제 등록 여부는 확인한다.
- 개발 브랜치로 browser-dev를 만들도록 안내했다. 실제 이름은 확인한다.
- 일반 사용 Firefox 프로필 대신 개발용 프로필로 검증한다.
알려진 오류와 해결한 설정
한국어 Windows에서 taskgraph가 .sh 파일을 읽을 때 다음 오류가 발생했다.
UnicodeDecodeError: 'cp949' codec can't decode byte 0xe2 ...
이후 Cannot find gmake도 출력됐다. 먼저 Python UTF-8 모드를 켜고 도구 준비/빌드를 다시 실행하도록 안내했으며, 이후 사용자가 성공을 보고했다.
MozillaBuild 셸에서:
cd /c/mozilla-source/firefox
export PYTHONUTF8=1
export는 현재 셸에 적용되므로 새 셸에서도 필요하면 다시 설정한다. Python 설정 확인:
python3 -c "import sys, locale; print(sys.flags.utf8_mode, locale.getpreferredencoding(False))"
기대 출력은 1 utf-8이다. PYTHONIOENCODING만으로 파일 읽기 문제를 해결했다고 가정하지 않는다.
도구 준비와 Artifact Build
도구가 준비되어 있으면 bootstrap을 매번 반복하지 않는다. 필요한 경우:
./mach bootstrap
Firefox for Desktop Artifact Mode를 선택한다. 저장소 루트 mozconfig의 기존 내용을 보존하면서 다음 설정을 확인한다.
ac_add_options --enable-artifact-builds
mk_add_options MOZ_OBJDIR=./objdir-frontend
첫 빌드와 실행:
./mach build
./mach run
지원되는 UI/JS/CSS 리소스 수정 후, 실행 중인 개발 브라우저를 종료하고:
./mach build faster
./mach run
설정/패키징 변경으로 빠른 빌드가 충분하지 않으면 ./mach build를 사용한다. Artifact Build에서는 C++/Rust 및 일부 WebIDL/빌드 설정 변경을 지원하지 않는다.
searchfox-cli, socorro-cli, stmo-cli, treeherder-cli, webspec-index 설치 실패 메시지가 있었다. 해당 설치 함수는 실패 시 메시지를 출력하고 계속 진행했다. 이 메시지만으로 전체 빌드 실패를 단정하지 말고 최종 오류를 확인한다.
작업과 검증
- 이 포크에서는 아래 원본 지침의 도구 관련 요구를 다음과 같이 보완한다. 사용 가능한 Searchfox/moz 도구를 활용하되, 보조 CLI가 설치되지 않았다는 이유만으로 작업을 멈추거나 bootstrap을 반복하지 않는다. 해당 도구가 없거나 로컬 변경 확인이 필요하면 수정 대상 경로에 한정한 rg와 파일 읽기로 진행한다.
- 대규모 저장소 전체 검색, 광범위한 정리/포맷 변경을 피한다. 필요한 파일만 변경하고 원본 업데이트를 받아오기 쉬운 작은 diff를 유지한다.
- 사용자 수정 사항을 덮어쓰거나 자동으로 원본 main에 맞춰 reset/rebase하지 않는다.
- 필요한 빌드와 관련 검사만 수행한다. ./mach lint <변경한 경로>와 동작 변경에 맞는 테스트를 사용한다. 단순 외형 변경에 전체 테스트 스위트를 돌리지 않는다.
- 동작 변경은 기본 탭 조작, 접기/펼치기, 창 크기 변경, 여러 탭의 스크롤, 밝은/어두운 테마, 포커스 표시를 확인한다. 세션 상태를 바꿨다면 재실행/새 창도 확인한다.
- Windows 실행 환경에 접근할 수 없는 에이전트는 빌드/화면 검증을 했다고 주장하지 않는다. 가능한 정적 검사를 끝내고 사용자에게 정확한 실행 절차를 전달한다.
- 수정과 검증은 승인된 범위에서 진행한다. 원격 push, 배포, Mozilla 제출은 사용자가 요청한 경우에만 수행한다.
- 작업 보고에는 변경된 화면/동작, 검증 결과, 미확인 사항을 짧게 적는다. 사용자의 개발 학습을 위해 필요한 Git/빌드 명령의 뜻은 설명한다.
이후 에이전틱 기능: 아직 설계 확정 전
- UI 기본형 이후 명령 입력 → 진행 표시 → 페이지 조작 → 결과 확인 및 중단/개입 흐름을 설계한다.
- 아이디어: 페이지에서 후보 요소 추출 → 목적 기반 필터/reranker → 동작 선택 → 필요한 경우 고성능 모델로 시각 검증.
- 특화 소형 모델/Jev 활용은 검토 중이며 확정된 의존성이 아니다. 모델 학습이나 API 통합을 현재 UI 작업에 자동으로 포함하지 않는다.
- 브라우저 UI의 document와 웹페이지의 DOM은 다르다. 페이지 관찰/조작은 Firefox의 프로세스 경계와 actor 통신을 고려해 설계한다.
- 속도 평가는 모델 호출 시간뿐 아니라 추출/실행/페이지 대기/실패 복구를 포함한 전체 작업 시간과 성공률로 판단한다.
참고 문서
- Windows 빌드: https://firefox-source-docs.mozilla.org/setup/windows_build.html
- Artifact Build: https://firefox-source-docs.mozilla.org/contributing/build/artifact_builds.html
- 브라우저 UI 개요: https://firefox-source-docs.mozilla.org/browser/overview.html
- 사이드바 구조: https://firefox-source-docs.mozilla.org/browser/components/sidebar/docs/index.html
아래의 Mozilla 원본 지침에 관하여
이 문서 뒤에 이어지는 원본 지침은 생성 시점의 포크 main에서 가져왔다. 원본 지침은 보존하되 이 포크의 작업 범위와 도구 예외는 위 프로젝트 지침을 우선한다. 현재 로컬 원본 지침이 달라졌다면 그 차이를 확인하고 병합한다.
Global instructions
Limit the amount of comments you put in the code to a strict minimum. You should almost never add comments, except sometimes on non-trivial code, function definitions if the arguments aren't self-explanatory, and class definitions and their members.
Do not remove existing comments unless they are directly related to what you are changing.
If you see a good first bug that isn't directly related to your work, don't hesitate to propose it as a good first bug (see the file-good-first-bug skill).
The Firefox repository is very big and so it isn't advised to blindly run rg or grep commands without specifying a narrow set of directories to search. When local text search via shell is necessary, prefer rg over grep as it is faster. There are tools available to help, see next section.
When working on anything under any of the following directories:
- js/
- gfx/wr/
- layout/
- security/nss/
- browser/extensions/newtab/
  Open AGENTS.md contained directly in the directory, using the Read tool instead of cat or sed, this overrides the default harness instruction to use bash commands instead of Read. security/nss/ is imported from upstream and has a CLAUDE.md instead; read that one.
Tooling for Firefox work
- Some tools useful for Firefox work are available in the moz MCP server
- Firefox is a very large repository, and it isn't efficient to search with usual tooling. When working on Firefox, you MUST use the searchfox-cli tool if you want to know about something. Its --help flag will show the options, but you probably want:
searchfox-cli --define 'AudioContext::AudioContext' # get function impl
searchfox-cli --define 'AudioSink' # get class definition
searchfox-cli --path ipdl -q 'MySearchTerm' # search for a text string, restrict on path
searchfox-cli --id AudioSink -l 150 --cpp # search for identifier audio sink in C++ code, 150 results max
- For C++, Rust and Java code, prefer searching for identifiers with searchfox-cli. Use text search restricted by path otherwise.
- Do not try to use identifier search for front-end identifiers like JS object or function names, CSS classes or HTML custom element names.
- searchfox-cli's --path can only be provided once, but supports globs so you can combine a path with a file extension restriction.
- If you must use regular expressions with searchfox-cli, don't forget the --regexp flag.
- Use the searchfox-cli tool, only using rg or usual local tools if you need to find information about something
  that has definitely changed locally. If you're unsure, ask.
- If recommended tooling (e.g. searchfox-cli, treeherder-cli) is missing, run ./mach bootstrap to install it; if it reports it needs updating, let the user know.
- If you can't find something quickly, it is better to ask than run local searches.
- ./mach is the main interface to the Mozilla build system and common developer tasks. Important commands are listed here, and you can run ./mach help for a full list of commands. If you want additional details for a given command, you can run ./mach COMMAND --help
- ./mach format: Format code. Run it without additional parameters to format all the files you have modified
- ./mach build: Build the project. Full builds can take a long time, up to tens of minutes.
- ./mach test --auto: Run tests
- ./mach run: Run the project
- ./mach doc --no-serve --no-open: Build the documentation
- ./mach python --virtualenv <virtualenv_name>: Execute Python of a Mach command's virtualenv. Value of virtualenv_name is in relevant @Command decorator. This avoids ImportErrors.
- treeherder-cli: Pull CI results for a try push.
- Use the MCP resource @moz:bugzilla://bug/{bug_id} to retrieve a bug
- Use the MCP resource @moz:phabricator://revision/D{revision_id} to retrieve a Phabricator revision
Fixing review comments
Use @moz:phabricator://revision/D{revision_id} to retrieve the revision and its comments.
You can find the review identifier by inspecting the commit log with:
- jj log -T builtin_log_detailed if using jj
- git log -v -l 10 if using git
Referring to code in bugs, reviews and commit messages
- Reference a name, not a position. This text outlives the code it describes, so cite a selector, function, class, pref or flag name; name a file without a line, and avoid positional phrasing ("the rule above X").
- Where a location genuinely helps, use a Searchfox permalink. Get it from searchfox-cli -q <term> -p <path> --permalink, which pins the revision Searchfox has indexed. Indexing lags landing by up to a day and an unindexed revision still answers HTTP 200, so a URL built by hand from git log has to be verified by grepping the page for content you expect. The form is https://searchfox.org/firefox-main/rev/<sha>/<path>#<line>, and the anchor also takes #169-176 or #9,12. The /source/<path> form follows tip and rots like a bare line number, so where Searchfox cannot cite the code yet, name the file and quote the lines instead.
Code Style
- Our style guide forbids the use of emoji.
Workflow
- This repository moves fast. If the local checkout looks old compared to origin/main, suggest pulling the latest changes before going further.
- You can run tests by using ./mach test --auto. Once you are satisfied with the tests you run locally, ask the user if they would like you to use mach try auto to run tests in CI
- When running slow commands like ./mach test, ./mach mochitest, etc., NEVER pipe their output through tail, grep, head, or other filters. Instead redirect output to a temporary file in artifacts/ (create if necessary) and selectively read this file. This avoids having to re-run slow commands multiple times to extract different pieces of information.
- Do not run ./mach build faster when only front-end test files (JS, HTML, etc.) were modified — they don't need compilation.
- Running tests with --headless is preferred if possible for the patch.
- Never submit patches to Phabricator without explicit user approval.
- In commit messages, group reviewers use a # prefix: r?#group-name (e.g. r?#linter-reviewers), while individual reviewers do not: r?username
- Refer to a bug by number as bug NNNNNN, and to one of its comments as bug NNNNNN comment N; Bugzilla and Phabricator auto-link that form case-insensitively, so capitalize where a sentence or commit subject starts. A bare comment N only resolves within the bug it belongs to, so spell the bug number out in commit messages, review comments and other bugs. Comment numbering is 0-based with the description as comment 0: take the number from a comment's count field rather than counting the comments you fetched.
- Never put DONTBUILD (or CLOSED TREE) in the -m message of mach try fuzzy / mach try compare when you want builds to actually run. The Gecko decision task scans the message and on DONTBUILD strips every task from the graph: the decision task itself succeeds (Treeherder shows green) but no builds are scheduled.
- When doing Android and Desktop front-end-only changes, use the special ./mach build faster to skip all C++/Rust compilation.
- Conversely, for C/C++/Obj-C/Rust only changes you can use the special ./mach build binaries to skip all front-end-related tasks.