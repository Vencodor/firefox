# Mono 브랜드 리소스

브라우저 이름은 **Mono**입니다. 사용자 제공 `mono-brand.zip`에서 가져온
원본 리소스이며, 파일명·SVG 메타데이터·애니메이션을 변경하지 않았습니다.

## 구성

- `logo/`: 정적 SVG 로고 8개.
- `animation/`: SVG 애니메이션 7개와 원본 미리보기 페이지.
- [애니메이션 미리보기](animation/preview.html): 로컬 브라우저에서 열 수 있습니다.

## 정적 로고

| 파일 | 구분 |
| --- | --- |
| `logo/logo-mark-glass.svg` | 유리 질감 심볼, 메인페이지 |
| `logo/logo-mark.svg` | 기존 기본 심볼 (제거 예정) |
| `logo/logo-mark-small.svg` | 작은 크기용 심볼 |
| `logo/logo-outline.svg` | 외곽선 심볼 |
| `logo/logo-outline-on-dark.svg` | 어두운 배경용 외곽선 심볼 |
| `logo/logo-outline-small.svg` | 작은 크기용 외곽선 심볼 |
| `logo/logo-outline-small-on-dark.svg` | 어두운 배경의 작은 크기용 외곽선 심볼 |
| `logo/mono-lockup-vertical.svg` | 세로 조합 로고 |
| `logo/mono-lockup-vertical-on-dark.svg` | 어두운 배경용 세로 조합 로고 |

## 애니메이션

아래 용도는 ZIP의 미리보기에 적힌 시안 설명입니다. 실제 브라우저 상태나
에이전트 기능에는 아직 연결하지 않았습니다.

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

SVG 15개는 `browser/base/jar.mn`에 등록되어 빌드에 포함됩니다.
리소스 주소의 공통 경로는 다음과 같습니다.

```text
chrome://browser/content/custom-ui/resources/mono/
```

예를 들어 기본 심볼은
`chrome://browser/content/custom-ui/resources/mono/logo/logo-mark.svg`로
참조합니다. `README.md`와 `animation/preview.html`은 소스 확인용이며
브라우저 패키지에는 포함하지 않습니다.

사이드바는 `logo/logo-mark-small.svg`, 메인페이지는 `logo/logo-mark-glass.svg`를
사용합니다. `logo/logo-mark.svg`는 제거 예정입니다. 운영체제 앱 아이콘·설치 프로그램 브랜딩과 애니메이션 연결은
별도 적용 작업입니다. 애니메이션을 연결할 때는 동작 줄이기 설정에서
정적 로고를 대신 표시하도록 처리합니다.
