# Mono 브랜드 리소스

브라우저 이름은 **Mono**입니다. 정적 로고는 Mono 전용으로 새로 그린 SVG이고,
애니메이션은 사용자 제공 원본을 변경하지 않고 보관합니다.

## 구성

- `logo/`: 정적 SVG 로고 4개. 세리프 소문자 `m`과 커서 머리로 된 심볼입니다.
- `app-icon/`: Windows 창·작업 표시줄용 `mono-app.ico`와 원본 `mono-app.svg`.
- `animation/`: 사용자 제공 `mono-brand.zip`의 SVG 애니메이션 7개와 원본 미리보기 페이지.
  이전 세로 막대 심볼 기준이며, 새 로고용 애니메이션으로 교체할 예정입니다.
- [애니메이션 미리보기](animation/preview.html): 로컬 브라우저에서 열 수 있습니다.

## 정적 로고

브라우저 UI와 Windows 아이콘 모두 배경 없는 심볼을 사용합니다.

| 파일 | 구분 | 사용처 |
| --- | --- | --- |
| `logo/mono-glyph.svg` | 심볼 (32px 이상) | 새 탭 중앙, 에이전트 채팅 빈 화면 |
| `logo/mono-glyph-small.svg` | 심볼 (32px 미만) | 사이드바, 설정 창 제목줄, 에이전트 채팅 제목·파비콘·작성자 |
| `logo/mono-glyph-black.svg` | 검은색 심볼 (어두운 테마는 흰색) | 주소창 추천의 브라우저 대화 항목 |
| `logo/mono-glyph-context.svg` | 단색 심볼 (`context-fill`) | 설정 탐색 제목, 에이전트 HUD |
| `app-icon/mono-app.svg` | Windows 아이콘 원본 (굵은 전용 디자인, 하늘색→민트 그라데이션) | `mono-app.ico` 제작용. 패키지에 포함하지 않음 |
| `app-icon/mono-app.ico` | Windows 아이콘 | Windows 브라우저 창·작업 표시줄 |

심볼 SVG는 내부의 `prefers-color-scheme`으로 밝은·어두운 테마 색을 바꿉니다.
선택 기준과 색상은 저장소 루트의 `Style.md` 3장을 따릅니다.

## 애니메이션

### 심볼 애니메이션

| 파일 | 동작 | 사용처 |
| --- | --- | --- |
| `animation/mono-glyph-spin-small.svg` | 광원 회전, 2.4초 반복 | 채팅 답변 생성 중 작성자 표시·탭 파비콘 |
| `animation/mono-glyph-spin.svg` | 광원 회전, 8초 반복 | 채팅 빈 화면 로고 |
| `animation/mono-glyph-draw.svg` | 획 그리기, 0.9초 한 번 | 브라우저 실행 후 첫 새 탭 홈 화면 로고 |
| `animation/mono-glyph-done.svg` | 완료 반짝임, 0.9초 한 번 | 채팅 답변 완료 시 작성자 표시 |

동작 줄이기 설정에서는 정적 심볼로 표시됩니다. 상세 규칙은 `Style.md` 3장을 따릅니다.

### 이전 애니메이션

사용자 제공 `mono-brand.zip`의 세로 막대 심볼 애니메이션입니다. 현재 사용하지 않습니다.

| 파일 | 미리보기 이름 | 시안 용도 |
| --- | --- | --- |
| `animation/mono-fill.svg` | 차오름 | 로딩 |
| `animation/mono-scan.svg` | 스캔 | 페이지 읽는 중 |
| `animation/mono-trace.svg` | 테두리 추적 | 이동·연결 중 |
| `animation/mono-stream.svg` | 스트리밍 | AI 답변 생성 중 |
| `animation/mono-breathe.svg` | 호흡 | AI 대기·생각 중 |
| `animation/mono-dawn.svg` | 새벽 순환 | 긴 작업 |
| `animation/mono-open.svg` | 열림 | 시작 화면 |

## 브라우저에서 참조

SVG 15개는 `browser/base/jar.mn`에, `app-icon/mono-app.ico`는 `browser/base/moz.build`에
등록되어 빌드에 포함됩니다.
리소스 주소의 공통 경로는 다음과 같습니다.

```text
chrome://browser/content/custom-ui/resources/mono/
```

예를 들어 심볼은
`chrome://browser/content/custom-ui/resources/mono/logo/mono-glyph.svg`로
참조합니다. `README.md`와 `animation/preview.html`은 소스 확인용이며
브라우저 패키지에는 포함하지 않습니다.

실행 파일·바로 가기·설치 프로그램 아이콘 교체(`browser/branding/`)와 애니메이션
연결은 별도 작업입니다. 애니메이션을 연결할 때는 동작 줄이기 설정에서 정적 로고를
대신 표시하도록 처리합니다.
